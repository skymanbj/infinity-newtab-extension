import { base64ToBytes, bytesToBase64 } from './core/base64';
import { isWebDavRequestMessage, type WebDavRequestMessage, type WebDavResponseMessage } from './core/webdav-bridge';

const MAX_TIMEOUT = 600_000;

/**
 * Executes WebDAV requests on behalf of the new tab page.
 *
 * The page itself cannot make these requests: it has no host permission, so a WebDAV
 * server that does not advertise CORS headers gets blocked by the browser before the
 * request is sent. The service worker does hold the granted host permission, so the
 * request goes through untouched.
 *
 * Kept free of application state on purpose — the service worker can be killed at any
 * time, and this is the only thing it needs to do.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (value: unknown) => void): boolean => {
    if (!isWebDavRequestMessage(message)) return false;
    void perform(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: describeTransportError(error) }));
    // Keep the message channel open until the async response is sent.
    return true;
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

function describeTransportError(error: unknown): string {
    if (error instanceof DOMException && error.name === 'TimeoutError') return '请求超时，服务器响应太慢';
    if (error instanceof TypeError) return '无法连接服务器：检查地址是否可达、端口是否被防火墙拦下';
    return error instanceof Error ? error.message : '服务器请求失败';
}
