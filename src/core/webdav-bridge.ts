/**
 * Wire format for WebDAV requests that are executed by the background service worker.
 *
 * Extension pages (newtab.html) are bound by the same-origin policy, so a cross-origin
 * WebDAV request is rejected before it ever leaves the browser. A service worker holding
 * a host permission is not subject to that rule, which is why the actual network call
 * happens there.
 *
 * Bodies travel as base64 strings because the message payload must stay JSON-safe.
 */
export const WEBDAV_REQUEST_TYPE = 'infinity-newtab-webdav-request';

export interface WebDavRequestMessage {
    type: typeof WEBDAV_REQUEST_TYPE;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    timeout: number;
}

export type WebDavResponseMessage =
    | { error: string }
    | { ok: boolean; status: number; body: string | null };

export function isWebDavRequestMessage(value: unknown): value is WebDavRequestMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    return message.type === WEBDAV_REQUEST_TYPE
        && typeof message.method === 'string'
        && typeof message.url === 'string'
        && typeof message.timeout === 'number'
        && (message.body === null || typeof message.body === 'string')
        && typeof message.headers === 'object'
        && message.headers !== null;
}

export function isWebDavResponseMessage(value: unknown): value is WebDavResponseMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    if (typeof message.error === 'string') return true;
    return typeof message.status === 'number'
        && typeof message.ok === 'boolean'
        && (message.body === null || typeof message.body === 'string');
}
