import { base64ToBytes, bytesToBase64 } from './base64';
import { isRecord } from './backup';
import { storageGet, storageRemove, storageSet } from './storage';
import {
    WEBDAV_REQUEST_TYPE,
    isWebDavResponseMessage,
    type WebDavRequestMessage,
    type WebDavResponseMessage
} from './webdav-bridge';
import type { BackupData } from './types';

export interface WebDavAccount {
    /** WebDAV collection URL, e.g. https://dav.example.com/remote.php/dav/files/me */
    url: string;
    username: string;
    password: string;
    /** Remote file name inside that collection. */
    file: string;
}

export interface WebDavFileInfo {
    href: string;
    name: string;
    size: number;
    modified: string;
}

/** Credentials stay in local storage: they are not synced to the Google account. */
export const WEBDAV_STORAGE_KEY = 'webdav';
export const DEFAULT_WEBDAV_FILE = 'infinity-newtab-backup.json';

/**
 * Uploads and downloads carry base64-embedded media, so they can reach several megabytes
 * over a slow line. Probing and deleting are byte-sized and get the short budget.
 */
const QUICK_TIMEOUT = 20_000;
const DOWNLOAD_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 240_000;
const MAX_URL_LENGTH = 400;
const MAX_CREDENTIAL_LENGTH = 200;
const MAX_FILE_LENGTH = 120;
const PROPFIND_BODY = '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>';
const UNUSABLE_FILE_NAME = /[\s/\\?*|#:"<>|]/;

/** Collapses user input into something a WebDAV server can address. */
export function sanitizeWebDavAccount(value: unknown): WebDavAccount {
    const record = isRecord(value) ? value : {};
    const username = typeof record.username === 'string' ? record.username.trim().slice(0, MAX_CREDENTIAL_LENGTH) : '';
    const password = typeof record.password === 'string' ? record.password.slice(0, MAX_CREDENTIAL_LENGTH) : '';
    const file = sanitizeFileName(typeof record.file === 'string' ? record.file : '');
    return {
        url: sanitizeBaseUrl(typeof record.url === 'string' ? record.url : ''),
        username,
        password,
        file
    };
}

/** Embedding credentials in the URL would leak them into access logs; Basic auth goes in a header. */
function sanitizeBaseUrl(value: string): string {
    const candidate = value.trim().slice(0, MAX_URL_LENGTH);
    if (!candidate) return '';
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        url.username = '';
        url.password = '';
        return url.href.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function sanitizeFileName(value: string): string {
    const file = value.trim().slice(0, MAX_FILE_LENGTH);
    return file && file !== '.' && file !== '..' && !UNUSABLE_FILE_NAME.test(file) ? file : DEFAULT_WEBDAV_FILE;
}

export function webDavHref(account: WebDavAccount): string {
    return `${account.url}/${sanitizeFileName(account.file)}`;
}

export async function loadWebDavAccount(): Promise<WebDavAccount | null> {
    const value = await storageGet<Record<string, unknown>>(WEBDAV_STORAGE_KEY, 'local');
    const account = sanitizeWebDavAccount(value[WEBDAV_STORAGE_KEY]);
    return account.url ? account : null;
}

export async function saveWebDavAccount(account: WebDavAccount): Promise<void> {
    await storageSet({ [WEBDAV_STORAGE_KEY]: sanitizeWebDavAccount(account) }, 'local');
}

export async function clearWebDavAccount(): Promise<void> {
    await storageRemove([WEBDAV_STORAGE_KEY], 'local');
}

/** Uploads a backup, overwriting whatever is already at that name. Returns the bytes sent. */
export async function uploadBackup(account: WebDavAccount, data: BackupData): Promise<number> {
    const body = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const response = await request(account, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }, UPLOAD_TIMEOUT);
    if (!response.ok) throw describeStatus(response.status, '上传');
    return body.size;
}

export async function downloadBackup(account: WebDavAccount): Promise<Blob> {
    const response = await request(account, { method: 'GET' }, DOWNLOAD_TIMEOUT);
    if (!response.ok) throw describeStatus(response.status, '下载');
    return response.blob();
}

/** Deletes the remote backup; returns whether anything was actually there. */
export async function deleteBackup(account: WebDavAccount): Promise<boolean> {
    const response = await request(account, { method: 'DELETE' }, QUICK_TIMEOUT);
    if (response.status === 404) return false;
    if (!response.ok) throw describeStatus(response.status, '删除');
    return true;
}

/** Reads the remote backup's size and modification time, or null when it does not exist yet. */
export async function inspectBackup(account: WebDavAccount): Promise<WebDavFileInfo | null> {
    const response = await request(account, {
        method: 'PROPFIND',
        headers: { Depth: '0', Accept: 'application/xml, text/xml', 'Content-Type': 'application/xml' },
        body: PROPFIND_BODY
    }, QUICK_TIMEOUT);
    if (response.status === 404) return null;
    if (!response.ok) throw describeStatus(response.status, '读取');
    return parsePropFind(await response.text(), sanitizeFileName(account.file));
}

async function request(account: WebDavAccount, init: RequestInit, timeout: number): Promise<Response> {
    if (usesBackgroundChannel(account.url)) {
        const result = await sendToBackground(account, init, timeout);
        // The worker already turns a transport failure into a Chinese sentence.
        if ('error' in result) throw new Error(result.error);
        return new Response(result.body ? base64ToBytes(result.body) : null, { status: result.status });
    }
    try {
        return await fetch(webDavHref(account), {
            ...init,
            headers: { ...initHeaders(init), ...authHeader(account) },
            signal: AbortSignal.timeout(timeout)
        });
    } catch (error) {
        throw describeTransportError(error);
    }
}

/**
 * Asks Chrome to grant access to this server. The user has to accept once; after that the
 * requests travel through the service worker and the server's CORS policy stops mattering.
 *
 * Every failure mode is logged, because a silent `false` here is indistinguishable from a
 * user clicking "don't allow" — and from Chrome refusing to show the prompt at all.
 */
export async function ensureWebDavAccess(account: WebDavAccount): Promise<boolean> {
    if (usesBackgroundChannel(account.url)) return true;
    const origin = originPatternOf(account.url);
    const permissions = chrome.permissions as { request?: (options: { origins: string[] }) => Promise<boolean> } | undefined;
    if (typeof permissions?.request !== 'function') {
        console.warn('[WebDAV] chrome.permissions.request 不存在 —— 扩展可能不是最新版本，请到 chrome://extensions 重新加载');
        return false;
    }
    let granted = false;
    try {
        granted = await permissions.request({ origins: [origin] });
    } catch (error) {
        console.warn('[WebDAV] 权限请求抛出异常:', error);
        return false;
    }
    const manifest = chrome.runtime.getManifest?.() as Record<string, unknown> | undefined;
    console.info(
        `[WebDAV] 网络权限: ${granted ? '已允许' : '未允许'} ${origin} | ` +
        `${String(manifest?.name ?? '未知扩展')} v${String(manifest?.version ?? '?')} | ` +
        `optional_host_permissions=${JSON.stringify(manifest?.optional_host_permissions ?? '未声明')} | ` +
        `service_worker=${JSON.stringify(manifest?.background ?? '未声明')}`
    );
    return granted;
}

/** True when the background worker is allowed to reach this server on our behalf. */
export function usesBackgroundChannel(url: string): boolean {
    const runtime = chrome.runtime as {
        hasHostPermission?: (options: { origins: string[] }) => boolean;
        sendMessage?: (message: unknown) => Promise<unknown>;
    };
    if (typeof runtime.hasHostPermission !== 'function' || typeof runtime.sendMessage !== 'function') return false;
    try {
        return runtime.hasHostPermission({ origins: [originPatternOf(url)] });
    } catch {
        return false;
    }
}

async function sendToBackground(account: WebDavAccount, init: RequestInit, timeout: number): Promise<WebDavResponseMessage> {
    const message: WebDavRequestMessage = {
        type: WEBDAV_REQUEST_TYPE,
        method: init.method ?? 'GET',
        url: webDavHref(account),
        headers: { ...initHeaders(init), ...authHeader(account) },
        body: await bodyToBase64(init.body),
        timeout
    };
    try {
        const result = await chrome.runtime.sendMessage(message);
        return isWebDavResponseMessage(result)
            ? result
            : { error: '后台服务未响应：请在 chrome://extensions 重新加载本扩展后重试' };
    } catch {
        return { error: '后台服务未响应：请在 chrome://extensions 重新加载本扩展后重试' };
    }
}

async function bodyToBase64(body: BodyInit | null | undefined): Promise<string | null> {
    if (body == null) return null;
    if (body instanceof Blob) return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
    if (typeof body === 'string') return bytesToBase64(new TextEncoder().encode(body));
    return null;
}

/**
 * chrome.permissions and runtime.hasHostPermission take *match patterns*, which must include
 * a path — a bare origin like `https://host` is rejected with "Empty path". So the pattern is
 * always `${origin}/*`, which covers every path under that host.
 */
function originPatternOf(url: string): string {
    try {
        return `${new URL(url).origin}/*`;
    } catch {
        return url;
    }
}

function initHeaders(init: RequestInit): Record<string, string> {
    if (!init.headers) return {};
    if (init.headers instanceof Headers) return Object.fromEntries([...init.headers.entries()]);
    if (Array.isArray(init.headers)) return Object.fromEntries(init.headers);
    return { ...init.headers };
}

/** Basic auth over UTF-8, since btoa only accepts Latin-1. */
function authHeader(account: WebDavAccount): Record<string, string> {
    if (!account.username && !account.password) return {};
    return { Authorization: `Basic ${bytesToBase64(new TextEncoder().encode(`${account.username}:${account.password}`))}` };
}

function parsePropFind(text: string, fallback: string): WebDavFileInfo | null {
    let document: Document;
    try {
        document = new DOMParser().parseFromString(text, 'application/xml');
    } catch {
        return null;
    }
    // Some servers answer 207 and report the missing file inside the status element.
    if (/404\s+Not Found/i.test(document.getElementsByTagName('d:status')[0]?.textContent ?? '')) return null;
    const entry = document.getElementsByTagName('d:response')[0] ?? document.documentElement;
    if (!entry) return null;
    const pick = (tag: string) => entry.getElementsByTagName(tag)[0]?.textContent ?? '';
    const href = pick('d:href').split('\x00')[0].trim();
    const display = pick('d:displayname').trim();
    return {
        href,
        name: display || href.split('/').pop() || fallback,
        size: Number(pick('d:getcontentlength').trim()) || 0,
        modified: pick('d:getlastmodified').trim()
    };
}

function describeStatus(status: number, action: string): Error {
    if (status === 401) return new Error('认证失败：账户或密码不正确');
    if (status === 403) return new Error('服务器拒绝访问：检查账号权限，以及服务器是否允许跨域访问');
    if (status === 404) return new Error('服务器上没有找到这个备份文件');
    if (status === 405) return new Error('服务器不允许这种方法，可能填的不是 WebDAV 端点');
    if (status === 507) return new Error('服务器存储空间不足');
    return new Error(`${action}失败：服务器返回 ${status}`);
}

function describeTransportError(error: unknown): Error {
    if (error instanceof DOMException && error.name === 'TimeoutError') return new Error('请求超时，服务器响应太慢');
    // 没拿到网络权限时才走页面直连，这时跨域策略说了算。浏览器把 CORS 拦截和断网
    // 都报成同一个 TypeError，无法从代码里区分，只能靠控制台里的现象判断。
    return new Error('无法连接服务器：服务器不允许跨域（CORS）。再点一次「保存并测试」并允许网络权限，请求会改走后台通道');
}
