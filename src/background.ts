import { base64ToBytes, bytesToBase64 } from './core/base64';
import { isWebDavRequestMessage, type WebDavRequestMessage, type WebDavResponseMessage } from './core/webdav-bridge';
import { isBingWallpaperRequestMessage, type BingWallpaperResponseMessage } from './core/wallpaper-bridge';

const MAX_TIMEOUT = 600_000;
const BING_ARCHIVE_URL = 'https://cn.bing.com/HPImageArchive.aspx';
const BING_BASE_URL = 'https://cn.bing.com';

/**
 * Executes WebDAV requests and Bing wallpaper fetching on behalf of the new tab page.
 *
 * In Manifest V3, extension pages (newtab.html) cannot bypass CORS for cross-origin APIs.
 * The background service worker holds the granted host permissions, allowing requests
 * to go through directly without CORS restrictions.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (value: unknown) => void): boolean => {
    if (isWebDavRequestMessage(message)) {
        void perform(message)
            .then(sendResponse)
            .catch((error) => sendResponse({ error: describeTransportError(error) }));
        return true;
    }
    if (isBingWallpaperRequestMessage(message)) {
        void fetchBingWallpaper()
            .then(sendResponse)
            .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '获取必应壁纸失败' }));
        return true;
    }
    return false;
});

async function perform(message: WebDavRequestMessage): Promise<WebDavResponseMessage> {
    try {
        const body = message.body ? base64ToBytes(message.body) : undefined;
        const response = await fetch(message.url, {
            method: message.method,
            headers: message.headers,
            body,
            signal: AbortSignal.timeout(Math.min(Math.max(message.timeout, 1_000), MAX_TIMEOUT))
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: response.ok, status: response.status, body: bytes.length ? bytesToBase64(bytes) : null };
    } catch (error) {
        return { error: describeTransportError(error) };
    }
}

async function fetchBingWallpaper(): Promise<BingWallpaperResponseMessage> {
    const randomIdx = Math.floor(Math.random() * 8);
    let response: Response;
    try {
        response = await fetch(`${BING_ARCHIVE_URL}?format=js&idx=${randomIdx}&n=8&t=${Date.now()}`, { cache: 'no-store' });
    } catch {
        try {
            response = await fetch(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=${randomIdx}&n=8&t=${Date.now()}`, { cache: 'no-store' });
        } catch {
            return { ok: false, error: '无法连接必应壁纸服务，请检查网络' };
        }
    }
    if (!response.ok) return { ok: false, error: `壁纸服务暂时不可用（${response.status}）` };

    interface BingImageItem {
        url?: string;
        urlbase?: string;
    }
    let data: { images?: BingImageItem[] };
    try {
        data = await response.json() as { images?: BingImageItem[] };
    } catch {
        return { ok: false, error: '壁纸数据解析失败' };
    }

    const list = data?.images;
    if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, error: '未获取到有效的风光壁纸数据' };
    }

    const chosen = list[Math.floor(Math.random() * list.length)];
    const rawUrl = chosen.url || (chosen.urlbase ? `${chosen.urlbase}_1920x1080.jpg` : '');
    if (!rawUrl) return { ok: false, error: '壁纸地址无效' };
    const imageUrl = rawUrl.startsWith('http') ? rawUrl : `${BING_BASE_URL}${rawUrl}`;

    let imgResponse: Response;
    try {
        imgResponse = await fetch(imageUrl, { cache: 'no-store' });
    } catch {
        return { ok: false, error: '下载壁纸图片失败，请检查网络' };
    }
    if (!imgResponse.ok) return { ok: false, error: `下载壁纸失败（${imgResponse.status}）` };

    const bytes = new Uint8Array(await imgResponse.arrayBuffer());
    return {
        ok: true,
        body: bytesToBase64(bytes),
        contentType: imgResponse.headers.get('content-type') || 'image/jpeg'
    };
}

function describeTransportError(error: unknown): string {
    if (error instanceof DOMException && error.name === 'TimeoutError') return '请求超时，服务器响应太慢';
    if (error instanceof TypeError) return '无法连接服务器：检查地址是否可达、端口是否被防火墙拦下';
    return error instanceof Error ? error.message : '服务器请求失败';
}
