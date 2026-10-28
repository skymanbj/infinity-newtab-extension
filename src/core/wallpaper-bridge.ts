export const BING_WALLPAPER_REQUEST_TYPE = 'infinity-newtab-bing-wallpaper-request';

export interface BingWallpaperRequestMessage {
    type: typeof BING_WALLPAPER_REQUEST_TYPE;
}

export interface BingWallpaperResponseMessage {
    ok: boolean;
    error?: string;
    body?: string;
    contentType?: string;
}

export function isBingWallpaperRequestMessage(value: unknown): value is BingWallpaperRequestMessage {
    return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).type === BING_WALLPAPER_REQUEST_TYPE);
}
