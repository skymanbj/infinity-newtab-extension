import type {
    AppSettings,
    Bookmark,
    LayoutSettings,
    WallpaperSettings
} from './types';
import { cleanText, normalizeUrl, sanitizeRemoteUrl } from './utils';

export const DEFAULT_SETTINGS: AppSettings = {
    layout: {
        showClock: true,
        showSearch: true,
        showBookmarks: true,
        showStatus: true,
        showRecent: true,
        openInNewTab: false,
        searchEngine: 'google',
        dockSource: 'recent',
        dockSize: 56,
        dockMagnify: true,
        saveSearches: true,
        backupReminder: true,
        recentExcluded: [],
        launchpadColumns: 0,
        launchpadRows: 0,
        launchpadTile: 104
    },
    wallpaper: {
        type: 'gradient',
        value: '',
        blur: 0,
        overlay: 12,
        idleHide: true,
        pauseOnBattery: true,
        pauseWhenHidden: true,
        sound: false
    },
    appearance: {
        clockFormat: '24h',
        dateFormat: 'long',
        enhancedAnimations: true,
        hdrHighlights: true,
        theme: 'auto',
        glass: 'clear',
        reduceTransparency: false
    }
};

export function mergeSettings(value: unknown): AppSettings {
    return sanitizeSettings(value);
}

export function sanitizeImportedData(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('Backup data must be an object');
    const sanitized: Record<string, unknown> = {};
    const bookmarks = sanitizeBookmarks(Array.isArray(value.bookmarks) ? value.bookmarks : []);
    sanitized.bookmarks = bookmarks;

    const folders = new Set<string>();
    if (Array.isArray(value.folders)) {
        value.folders.forEach((folder) => {
            const name = cleanText(folder, 80);
            if (name) folders.add(name);
        });
    }
    folders.add('全部');
    bookmarks.forEach((bookmark) => folders.add(bookmark.folder));
    sanitized.folders = Array.from(folders);

    if (value.settings !== undefined) sanitized.settings = sanitizeSettings(value.settings);
    if (Array.isArray(value.todos)) sanitized.todos = value.todos;
    if (Array.isArray(value.recentSearches)) {
        sanitized.recentSearches = value.recentSearches
            .map((entry) => cleanText(entry, 200))
            .filter(Boolean)
            .slice(0, 20);
    }
    const backupTime = Number(value.lastBackupPrompt);
    if (Number.isFinite(backupTime)) sanitized.lastBackupPrompt = backupTime;
    return sanitized;
}

export function sanitizeBookmarks(values: unknown[]): Bookmark[] {
    const merged = new Map<string, Bookmark>();
    const seenIds = new Set<string>();
    values.forEach((raw, index) => {
        if (!isRecord(raw)) return;
        const url = normalizeUrl(raw.url);
        if (!url) return;
        const folder = cleanText(raw.folder, 80) || '全部';
        const key = `${folder}|${canonicalUrl(url)}`;
        if (merged.has(key)) return;
        const rawId = typeof raw.id === 'number' || typeof raw.id === 'string'
            ? raw.id
            : Date.now() + index;
        /**
         * 官方备份和转换器会把同一个 id 发给完全不同的站点。按 id 的 find /
         * findIndex 只会命中第一条，于是「编辑任何一条都是同一条」，而
         * deleteBookmark 会误删全部同 id 记录。撞号的 id 换成由 folder+url
         * 派生的稳定值：刷新后仍是同一个，不会因为每次加载都重新生成而漂移。
         */
        const id = seenIds.has(String(rawId)) ? dedupId(key) : rawId;
        seenIds.add(String(id));
        const icon = sanitizeBookmarkIcon(raw.icon);
        const order = Number(raw.order);
        merged.set(key, {
            id,
            folder,
            url,
            name: cleanText(raw.name, 160) || new URL(url).hostname,
            icon,
            order: Number.isFinite(order) ? order : index
        });
    });

    const folders = new Map<string, Bookmark[]>();
    merged.forEach((bookmark) => {
        const list = folders.get(bookmark.folder) ?? [];
        list.push(bookmark);
        folders.set(bookmark.folder, list);
    });
    folders.forEach((list) => {
        list.sort((left, right) => left.order - right.order || String(left.id).localeCompare(String(right.id)));
        list.forEach((bookmark, index) => { bookmark.order = index; });
    });
    return Array.from(merged.values());
}

/** 原始数据里是否存在重复主键：true 说明 sanitizeBookmarks 改写过 id，需要写回存储。 */
export function hasDuplicateBookmarkIds(values: unknown[]): boolean {
    const seen = new Set<string>();
    for (const row of values) {
        if (!isRecord(row)) continue;
        const id = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : '';
        if (!id) continue;
        if (seen.has(id)) return true;
        seen.add(id);
    }
    return false;
}

export function sanitizeSettings(value: unknown): AppSettings {
    const source = isRecord(value) ? value : {};
    const layout = isRecord(source.layout) ? source.layout : {};
    const wallpaper = isRecord(source.wallpaper) ? source.wallpaper : {};
    const appearance = isRecord(source.appearance) ? source.appearance : {};
    const searchEngines = ['google', 'bing', 'baidu', 'duckduckgo'];
    const wallpaperTypes = ['gradient', 'preset', 'local', 'video'];

    return {
        layout: {
            showClock: booleanOr(layout.showClock, true),
            showSearch: booleanOr(layout.showSearch, true),
            showBookmarks: booleanOr(layout.showBookmarks, true),
            showStatus: booleanOr(layout.showStatus, true),
            showRecent: booleanOr(layout.showRecent, true),
            openInNewTab: booleanOr(layout.openInNewTab, false),
            searchEngine: searchEngines.includes(String(layout.searchEngine))
                ? layout.searchEngine as LayoutSettings['searchEngine']
                : 'google',
            /** Missing values (including old backups) follow the new default; only an explicit choice is kept. */
            dockSource: layout.dockSource === 'bookmarks' ? 'bookmarks' : 'recent',
            dockSize: Math.round(clampNumber(layout.dockSize, 40, 72, 56)),
            dockMagnify: booleanOr(layout.dockMagnify, true),
            saveSearches: booleanOr(layout.saveSearches, true),
            backupReminder: booleanOr(layout.backupReminder, true),
            recentExcluded: hostList(layout.recentExcluded),
            // 0 表示「自动」，所以下限是 0 而不是 4：老备份没有这三个键时也落在自动上。
            launchpadColumns: Math.round(clampNumber(layout.launchpadColumns, 0, 14, 0)),
            launchpadRows: Math.round(clampNumber(layout.launchpadRows, 0, 8, 0)),
            launchpadTile: Math.round(clampNumber(layout.launchpadTile, 64, 140, 104))
        },
        wallpaper: {
            type: wallpaperTypes.includes(String(wallpaper.type))
                ? wallpaper.type as WallpaperSettings['type']
                : 'gradient',
            value: sanitizeWallpaperValue(wallpaper.value),
            blur: clampNumber(wallpaper.blur, 0, 40, 0),
            overlay: clampNumber(wallpaper.overlay, 0, 60, 12),
            idleHide: booleanOr(wallpaper.idleHide, true),
            pauseOnBattery: booleanOr(wallpaper.pauseOnBattery, true),
            pauseWhenHidden: booleanOr(wallpaper.pauseWhenHidden, true),
            sound: booleanOr(wallpaper.sound, false)
        },
        appearance: {
            clockFormat: appearance.clockFormat === '12h' ? '12h' : '24h',
            dateFormat: appearance.dateFormat === 'short' ? 'short' : 'long',
            enhancedAnimations: booleanOr(appearance.enhancedAnimations, true),
            hdrHighlights: booleanOr(appearance.hdrHighlights, true),
            theme: sanitizeTheme(appearance.theme, layout),
            glass: appearance.glass === 'tinted' ? 'tinted' : 'clear',
            reduceTransparency: booleanOr(appearance.reduceTransparency, false)
        }
    };
}

export function dataUrlToBlob(dataUrl: unknown): Blob | null {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    const [header, payload] = dataUrl.split(',', 2);
    if (!payload) return null;
    const mime = header.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
    try {
        const decoded = header.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
        const bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
}

function canonicalUrl(value: string): string {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.toLowerCase();
}

/** FNV-1a over the folder+url key, so a reimported collision resolves to the same id. */
function dedupId(key: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `dedup-${(hash >>> 0).toString(36)}`;
}

/**
 * Before 2.5 `light` was the default everyone had, so it moves to `auto` (which
 * still picks dark text on bright wallpapers). 2.5 settings are recognised by
 * the `openInNewTab` flag introduced alongside the automatic theme.
 */
function sanitizeTheme(theme: unknown, layout: Record<string, unknown>): AppSettings['appearance']['theme'] {
    if (theme === 'dark') return 'dark';
    if (theme === 'light') return typeof layout.openInNewTab === 'boolean' ? 'light' : 'auto';
    return 'auto';
}

/** Inline icons live in sync storage, so oversized data URLs are dropped instead of breaking the quota. */
export const MAX_INLINE_ICON_LENGTH = 4096;

export function sanitizeBookmarkIcon(value: unknown): string {
    const icon = sanitizeRemoteUrl(value, true);
    return icon.startsWith('data:') && icon.length > MAX_INLINE_ICON_LENGTH ? '' : icon;
}

function sanitizeWallpaperValue(value: unknown): string {
    if (typeof value === 'string' && (value === '' || /^(local|online)(-\d+)?$/.test(value))) return value;
    return sanitizeRemoteUrl(value, true);
}

/** “常访问”屏蔽名单：只保留单个 host 形式的短字符串，去重并按上限截断。 */
const MAX_RECENT_EXCLUDED = 500;
const MAX_RECENT_HOST_LENGTH = 200;
function hostList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    for (const entry of value) {
        const host = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
        if (!host || host.length > MAX_RECENT_HOST_LENGTH || /\s/.test(host)) continue;
        if (!result.includes(host)) result.push(host);
        if (result.length === MAX_RECENT_EXCLUDED) break;
    }
    return result;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
