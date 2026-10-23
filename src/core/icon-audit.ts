import type { Bookmark } from './types';

/** 二级公共后缀（co.uk、com.cn 等）需要多取一段，否则不同站点会被当成同一站。 */
const TWO_LEVEL_SUFFIX = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

/** 粗粒度站点键：同一站点的不同子域视为一个。 */
export function siteKeyOf(url: string): string {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        const parts = host.split('.');
        const take = parts.length >= 3 && TWO_LEVEL_SUFFIX.test(parts.slice(-2).join('.')) ? 3 : 2;
        return parts.slice(-take).join('.');
    } catch {
        return '';
    }
}

/**
 * 被多个不同站点共用的远程图标几乎一定是坏数据。
 *
 * Infinity 官方的 `user-share-icon` / `custom-icon` 是按 ID 串取图的，ID 一旦串号，
 * 十几个毫不相关的站点会同时显示同一张图（实测是京东的 logo）。
 * 内嵌的 data: 图标是内容寻址的，重复就是用户刻意复用，不在此列。
 */
export function sharedIconUrls(bookmarks: Bookmark[]): Set<string> {
    const usage = new Map<string, Set<string>>();
    bookmarks.forEach((bookmark) => {
        if (!bookmark.icon.startsWith('http')) return;
        const sites = usage.get(bookmark.icon) ?? new Set<string>();
        sites.add(siteKeyOf(bookmark.url));
        usage.set(bookmark.icon, sites);
    });
    return new Set(
        [...usage.entries()].filter(([, sites]) => sites.size > 1).map(([icon]) => icon)
    );
}

/** 清掉共用图标，交回按域名取 favicon。返回清理后的书签与被清掉的数量。 */
export function stripSharedIcons(bookmarks: Bookmark[]): { bookmarks: Bookmark[]; cleared: number } {
    const shared = sharedIconUrls(bookmarks);
    if (!shared.size) return { bookmarks, cleared: 0 };
    let cleared = 0;
    const next = bookmarks.map((bookmark) => {
        if (!shared.has(bookmark.icon)) return bookmark;
        cleared += 1;
        return { ...bookmark, icon: '' };
    });
    return { bookmarks: next, cleared };
}
