import assert from 'node:assert/strict';
import { sanitizeBookmarks, sanitizeImportedData, sanitizeSettings } from '../src/core/backup';
import { BOOKMARK_CHUNKS_KEY, bookmarkChunkKey } from '../src/core/bookmark-storage';
import { rankSites } from '../src/core/history';
import { sharedIconUrls, siteKeyOf, stripSharedIcons } from '../src/core/icon-audit';
import { formatBytes, iconByteSize, isInlineIcon } from '../src/core/image-icon';
import { AppStore } from '../src/core/store';
import { convexSquircle, lipSquircle, precalculateDisplacements } from '../src/components/liquid-optics';
import { hostOf } from '../src/components/site-icon';
import { bookmarkIcon, bookmarkIconCanUpgrade, bookmarkIconFallback, bookmarkIconIsRaster, bookmarkIconSrcSet, faviconUrl, normalizeUrl } from '../src/core/utils';
import { base64ToBytes, bytesToBase64 } from '../src/core/base64';
import {
    DEFAULT_WEBDAV_FILE,
    deleteBackup,
    ensureWebDavAccess,
    loadWebDavAccount,
    saveWebDavAccount,
    sanitizeWebDavAccount,
    uploadBackup,
    usesBackgroundChannel,
    webDavHref
} from '../src/core/webdav';
import {
    WEBDAV_REQUEST_TYPE,
    isWebDavRequestMessage,
    isWebDavResponseMessage,
    type WebDavRequestMessage
} from '../src/core/webdav-bridge';

const syncData: Record<string, unknown> = {};
const localData: Record<string, unknown> = {};
let failWrites = false;

const runtime = {
    lastError: null as { message: string } | null,
    getURL: (path: string) => `chrome-extension://unit-test${path}`
};
function area(data: Record<string, unknown>) {
    return {
        get(keys: string[] | string | null, callback: (value: Record<string, unknown>) => void) {
            if (keys === null) callback({ ...data });
            else if (typeof keys === 'string') callback({ [keys]: data[keys] });
            else callback(Object.fromEntries(keys.map((key) => [key, data[key]])));
        },
        set(values: Record<string, unknown>, callback: () => void) {
            runtime.lastError = failWrites ? { message: 'quota exceeded' } : null;
            if (!failWrites) Object.assign(data, structuredClone(values));
            callback();
            runtime.lastError = null;
        },
        remove(keys: string[], callback: () => void) {
            keys.forEach((key) => delete data[key]);
            callback();
        },
        clear(callback: () => void) {
            Object.keys(data).forEach((key) => delete data[key]);
            callback();
        }
    };
}

(globalThis as any).chrome = { runtime, storage: { sync: area(syncData), local: area(localData) } };

const oldBackup = sanitizeImportedData({
    bookmarks: [
        { id: 1, name: 'www.google.com', url: 'https://www.google.com/' },
        { id: 2, name: 'www.v2ex.com', url: 'https://www.v2ex.com/', folder: '全部', order: 2 },
        { id: 3, name: 'Duplicate', url: 'https://www.v2ex.com/', folder: '全部', order: 9 }
    ],
    folders: ['全部'],
    settings: {
        layout: { showClock: true, showSearch: true, showBookmarks: true, showTodo: true },
        wallpaper: { type: 'preset', value: 'https://images.unsplash.com/photo.jpg', blur: 0, overlay: 30 },
        appearance: { clockFormat: '24h', dateFormat: 'long' }
    },
    todos: []
});

assert.equal((oldBackup.bookmarks as any[]).length, 2, '旧备份中的重复书签必须合并');
assert.equal((oldBackup.bookmarks as any[])[0].folder, '全部');
assert.equal((oldBackup.settings as any).layout.showStatus, true);
assert.equal((oldBackup.settings as any).layout.showRecent, true);
assert.equal((oldBackup.settings as any).appearance.hdrHighlights, true);
assert.equal('showTodo' in (oldBackup.settings as any).layout, false);
assert.equal((oldBackup.settings as any).appearance.theme, 'auto', '旧版本默认的配色应迁移为自动');
assert.equal(sanitizeSettings({ appearance: { theme: 'light' } }).appearance.theme, 'auto', '2.5 之前的 light 是默认值，应迁移为自动');
assert.equal(sanitizeSettings({ layout: { openInNewTab: false }, appearance: { theme: 'light' } }).appearance.theme, 'light', '2.5 之后主动选择的深色文字必须保留');
assert.equal(sanitizeSettings({ appearance: { theme: 'dark' } }).appearance.theme, 'dark');
assert.equal(sanitizeSettings({ wallpaper: { type: 'local', value: 'online-123' } }).wallpaper.value, 'online-123', '缓存的在线壁纸需要保留版本号以触发刷新');
assert.equal(sanitizeSettings({}).layout.dockSource, 'recent', 'Dock 默认显示常访问');
assert.equal(sanitizeSettings({ layout: { dockSource: 'bookmarks' } }).layout.dockSource, 'bookmarks', '主动选择的固定书签必须保留');
assert.deepEqual(
    sanitizeSettings({ layout: { recentExcluded: ['A.com', 'a.com', ' b.com ', 'not a host\nx', '', 7, null] } }).layout.recentExcluded,
    ['a.com', 'b.com'],
    '常访问屏蔽名单要转小写、去重并丢弃空值和带空白的项'
);
assert.deepEqual(sanitizeSettings({ layout: { recentExcluded: 'youtube.com' } }).layout.recentExcluded, [], '旧备份里没有这个字段时应回落到空名单');

const unsafe = sanitizeImportedData({
    bookmarks: [{ id: 1, name: 'bad', url: 'javascript:alert(1)', icon: 'javascript:alert(2)' }],
    folders: ['全部', '<script>'],
    settings: {
        wallpaper: { type: 'bad', value: 'javascript:alert(3)', blur: 99, overlay: -4 },
        appearance: { theme: 'bad' },
        layout: { searchEngine: 'bad' }
    },
    unknown: 'drop me'
});
assert.equal((unsafe.bookmarks as any[]).length, 0);
assert.equal((unsafe.settings as any).wallpaper.type, 'gradient');
assert.equal((unsafe.settings as any).wallpaper.value, '');
assert.equal((unsafe.settings as any).wallpaper.blur, 40);
assert.equal((unsafe.settings as any).wallpaper.overlay, 0);
assert.equal('unknown' in unsafe, false);

const extensionPage = 'chrome-extension://hjekpdhdabgkokjbklegnfkogcpjhhhg/index.html';
assert.equal(normalizeUrl(extensionPage), extensionPage, '其他扩展的页面应能作为书签地址');
assert.equal(normalizeUrl('chrome-extension:///index.html'), '', '缺少扩展 ID 的地址必须拒绝');
assert.equal(normalizeUrl('javascript:alert(1)'), '', '危险协议必须继续拒绝');

const extensionBackup = sanitizeImportedData({
    bookmarks: [{ id: 'extension-page', name: '扩展页面', url: extensionPage }],
    folders: ['全部']
});
assert.equal((extensionBackup.bookmarks as any[])[0].url, extensionPage, '导入备份时应保留扩展页面书签');

const managedBookmark = { id: 10, name: 'Google', url: 'https://www.google.com/', icon: 'https://www.google.com/s2/favicons?domain=google.com&sz=64', folder: '全部', order: 0 };
assert.ok(bookmarkIcon(managedBookmark).includes('size=128'), '旧 Google favicon 地址应切换到 Chrome 的高尺寸接口');
assert.ok(bookmarkIconSrcSet(managedBookmark).includes('size=256'), '高 DPI 显示应准备更高尺寸的 favicon');
assert.ok(bookmarkIconFallback(managedBookmark).startsWith('data:image/svg+xml;base64,PHN2Zy'), '托管 favicon 失败时应使用安全的本地占位图');
assert.ok(faviconUrl(managedBookmark.url, 64).includes('size=64'));

const customBookmark = { ...managedBookmark, icon: 'https://assets.example/icon.png' };
assert.equal(bookmarkIcon(customBookmark), customBookmark.icon, '自定义图标不能被导入流程覆盖');
assert.equal(bookmarkIconCanUpgrade(customBookmark), true, '自定义图标应允许检查实际分辨率');
assert.equal(bookmarkIconCanUpgrade(managedBookmark), false, 'Chrome 管理的 favicon 不需要重复升级');
assert.equal(bookmarkIconIsRaster(managedBookmark), true, 'Chrome favicon 应按位图显示策略处理');
assert.equal(bookmarkIconIsRaster({ ...managedBookmark, icon: 'data:image/svg+xml;base64,PHN2Zy' }), false, 'SVG 图标不应套用位图放大策略');
assert.ok(bookmarkIconFallback(customBookmark).includes('size=128'), '自定义图标失败时应回退到本地 favicon');

// 本地图片图标：内嵌 data: 是用户明确选的，哪怕像素少也不能被 favicon 顶掉。
const localBookmark = { ...managedBookmark, icon: 'data:image/webp;base64,AAAA' };
assert.equal(bookmarkIconCanUpgrade(localBookmark), false, '本地图片图标不应被自动升级成 favicon');
assert.equal(bookmarkIcon(localBookmark), localBookmark.icon, '本地图片图标应原样显示');
assert.equal(isInlineIcon(localBookmark.icon), true, 'data:image 应被识别为内嵌图标');
assert.equal(isInlineIcon('https://assets.example/icon.png'), false, '远程地址不是内嵌图标');
assert.equal(iconByteSize('data:image/png;base64,AAAA'), 3, 'base64 长度应换算成真实字节数');
assert.equal(iconByteSize('data:image/png;base64,AAA='), 2, '带填充的 base64 不应多算一个字节');
assert.equal(formatBytes(900), '900 B');
assert.equal(formatBytes(4096), '4.0 KB');

const ranked = rankSites([
    { url: 'https://www.youtube.com/', title: 'YouTube', visitCount: 1, lastVisitTime: 150 },
    { url: 'https://www.youtube.com/watch?v=1', visitCount: 8, lastVisitTime: 200 },
    { url: 'https://youtube.com/watch?v=2', visitCount: 4, lastVisitTime: 300 },
    { url: 'https://www.v2ex.com/t/1', visitCount: 5, lastVisitTime: 100 },
    { url: 'https://www.google.com/search?q=noise', visitCount: 99, lastVisitTime: 500 }
]);
assert.equal(ranked.length, 2);
assert.equal(ranked[0].host, 'youtube.com');
assert.equal(ranked[0].url, 'https://www.youtube.com/', '应打开实际访问最多的主机名，而不是强行去掉 www');
assert.equal(ranked[0].count, 13);
assert.equal(ranked[0].title, 'YouTube', '首页标题可用时应作为网站名');
assert.equal(ranked[1].title, 'v2ex.com', '没有首页标题时显示完整域名，而不是只取第一段');
assert.equal(rankSites([{ url: 'https://news.ycombinator.com/item?id=1', visitCount: 3 }])[0].title, 'news.ycombinator.com');

const localSites = rankSites([
    { url: 'http://localhost:18923/#/dashboard', title: '本地面板', visitCount: 6, lastVisitTime: 200 },
    { url: 'http://localhost:3000/', title: 'Vite', visitCount: 3, lastVisitTime: 100 },
    { url: 'http://localhost:3000/app', visitCount: 1, lastVisitTime: 50 }
]);
assert.equal(localSites.length, 2, '不同端口的本地服务必须分开统计');
assert.equal(localSites[0].host, 'localhost:18923', 'host 需要保留端口');
assert.equal(localSites[0].url, 'http://localhost:18923/', '端口必须保留在打开的地址里');
assert.equal(localSites[1].url, 'http://localhost:3000/', '同一端口的不同路径合并到一个站点');
assert.equal(localSites[1].count, 4);
assert.equal(rankSites([{ url: 'https://example.com:8443/app', visitCount: 2 }])[0].url, 'https://example.com:8443/');
assert.equal(hostOf('http://localhost:18923/#/x'), 'localhost:18923', 'hostOf 也要带上端口');
assert.equal(hostOf('https://www.youtube.com/watch'), 'youtube.com');

// 「从常访问移除」按 host 屏蔽，不动浏览器历史：被屏蔽的站点整站消失，其他站点不受影响。
const excludedSites = rankSites([
    { url: 'https://www.youtube.com/', title: 'YouTube', visitCount: 1, lastVisitTime: 150 },
    { url: 'https://www.youtube.com/watch?v=1', visitCount: 8, lastVisitTime: 200 },
    { url: 'https://www.v2ex.com/t/1', visitCount: 5, lastVisitTime: 100 },
    { url: 'http://localhost:3000/', visitCount: 2, lastVisitTime: 50 }
], new Set(['youtube.com', 'localhost:3000']));
assert.equal(excludedSites.length, 1, '被屏蔽的 host 必须整站消失，包括它下面的所有路径');
assert.equal(excludedSites[0].host, 'v2ex.com');
assert.equal(rankSites([{ url: 'http://localhost:3000/' }], new Set(['localhost'])).length, 1, '屏蔽 localhost 不能连带影响 localhost:3000');

// 图标串号：官方 user-share-icon 会把同一个 ID 解析成同一张图，跨站共用即坏数据。
const jdIcon = 'https://infinityicon.infinitynewtab.com/user-share-icon/cee009549b352def723ba09d6da4b742.png';
const iconBookmarks = [
    { id: 1, name: 'Telegram', url: 'https://web.telegram.org/k', icon: jdIcon, folder: '全部', order: 0 },
    { id: 2, name: 'Mistral', url: 'https://console.mistral.ai/home', icon: jdIcon, folder: '全部', order: 1 },
    { id: 3, name: 'B 站', url: 'https://www.bilibili.com/', icon: 'https://www.bilibili.com/favicon.ico', folder: '全部', order: 2 },
    { id: 4, name: '番剧', url: 'https://www.bilibili.com/anime/', icon: 'https://www.bilibili.com/favicon.ico', folder: '全部', order: 3 },
    { id: 5, name: '谷歌', url: 'https://www.google.com/', icon: '', folder: '全部', order: 4 }
];
assert.equal(sharedIconUrls(iconBookmarks).size, 1, '只有跨站复用的图标才算坏数据');
const stripped = stripSharedIcons(iconBookmarks);
assert.equal(stripped.cleared, 2);
assert.equal(stripped.bookmarks[0].icon, '', '跨站共用的图标必须清空');
assert.equal(stripped.bookmarks[2].icon, 'https://www.bilibili.com/favicon.ico', '同一站点的不同页面共用图标是正常的');
assert.equal(siteKeyOf('https://docs.google.com/x'), 'google.com');
assert.equal(siteKeyOf('https://www.bbc.co.uk/news'), 'bbc.co.uk', '二级公共后缀不能只取最后两段');
assert.equal(siteKeyOf('not a url'), '');

const opticalSamples = precalculateDisplacements(55, 63, convexSquircle, 1.5, 128);
assert.equal(opticalSamples.length, 128, '折射场必须覆盖 SVG 颜色通道的 128 个径向取样位置');
assert.ok(opticalSamples.every(Number.isFinite));
assert.ok(Math.abs(opticalSamples.at(-1) ?? 0) < Math.abs(opticalSamples[0]), '位移应从玻璃边缘向平面区域平滑衰减');
assert.ok(Math.max(...opticalSamples.map(Math.abs)) > 70, '凸面 squircle 必须产生可见的物理位移');
assert.ok(convexSquircle(0.5) > 0.9, '凸面 squircle 应保持平滑的内侧曲率');

const lipSamples = precalculateDisplacements(55, 63, lipSquircle, 1.5, 128);
assert.ok(lipSamples.every(Number.isFinite));
assert.ok(Math.max(...lipSamples) > 50 && Math.min(...lipSamples) < -30, 'lip 表面必须同时产生凸缘和凹心折射');
assert.equal(lipSquircle(0), 0);
assert.equal(lipSquircle(1), 0);

async function testTransactions(): Promise<void> {
    Object.assign(syncData, {
        bookmarks: [
            { id: 'a', name: 'A', url: 'https://a.example/', icon: '', folder: '全部', order: 0 },
            { id: 'b', name: 'B', url: 'https://b.example/', icon: '', folder: '全部', order: 1 },
            { id: 'c', name: 'C', url: 'https://c.example/', icon: '', folder: 'POM', order: 0 }
        ],
        folders: ['全部', 'POM'],
        settings: sanitizeSettings({}),
        recentSearches: []
    });
    const store = new AppStore();
    await store.init();
    await store.moveBookmark('a', 'POM');
    assert.equal(store.state.bookmarks.length, 3, '移动不能复制书签');
    assert.deepEqual(store.state.bookmarks.filter((bookmark) => bookmark.folder === 'POM').map((bookmark) => bookmark.id).sort(), ['a', 'c']);
    assert.deepEqual(store.state.bookmarks.filter((bookmark) => bookmark.folder === '全部').map((bookmark) => bookmark.id), ['b']);

    await store.moveBookmark('a', 'POM', 'c');
    assert.deepEqual(
        store.state.bookmarks.filter((bookmark) => bookmark.folder === 'POM').sort((left, right) => left.order - right.order).map((bookmark) => bookmark.id),
        ['a', 'c'],
        '同文件夹排序不能复制数据'
    );

    // 标签排序：「全部」固定在第一位，其余可任意调整。
    await store.addFolder('工作');
    await store.addFolder('娱乐');
    assert.deepEqual(store.state.folders, ['全部', 'POM', '工作', '娱乐']);
    await store.moveFolder('娱乐', 0);
    assert.deepEqual(store.state.folders, ['全部', '娱乐', 'POM', '工作'], '标签顺序要能整体调整');
    assert.deepEqual(syncData.folders, ['全部', '娱乐', 'POM', '工作'], '新顺序要写回同步存储');
    assert.equal(await store.moveFolder('娱乐', 0), false, '位置没变时不应重复写入');
    assert.equal(await store.moveFolder('全部', 2), false, '「全部」固定在第一位');
    assert.equal(await store.moveFolder('不存在', 0), false, '未知文件夹不应改变顺序');
    await store.moveFolder('POM', 99);
    assert.deepEqual(store.state.folders, ['全部', '娱乐', '工作', 'POM'], '越界下标要收敛到末尾');
    await store.moveFolder('POM', -5);
    assert.deepEqual(store.state.folders, ['全部', 'POM', '娱乐', '工作'], '负下标要收敛到开头');
    await store.deleteFolder('POM');
    await store.deleteFolder('工作');
    await store.deleteFolder('娱乐');
    assert.deepEqual(store.state.folders, ['全部'], '清理测试用文件夹');

    const extensionBookmark = await store.addBookmark({ name: '扩展页面', url: extensionPage, icon: '', folder: '全部' });
    assert.equal(extensionBookmark.url, extensionPage, '新增书签应接受 chrome-extension 页面');

    assert.equal('bookmarks' in syncData, false, '保存后应移除旧的单键书签数组');
    assert.equal(syncData[BOOKMARK_CHUNKS_KEY], 1);

    for (let index = 0; index < 150; index += 1) {
        await store.addBookmark({ name: `站点 ${index}`, url: `https://site-${index}.example.com/some/longer/path?ref=${index}`, icon: '', folder: '全部' });
    }
    const chunkCount = Number(syncData[BOOKMARK_CHUNKS_KEY]);
    assert.ok(chunkCount > 1, '大量书签必须拆分为多个同步分片');
    for (let index = 0; index < chunkCount; index += 1) {
        const key = bookmarkChunkKey(index);
        const bytes = new TextEncoder().encode(key + JSON.stringify(syncData[key])).length;
        assert.ok(bytes < 8192, `分片 ${key} 超过 chrome.storage.sync 单项 8KB 上限：${bytes}`);
    }
    const reloaded = new AppStore();
    await reloaded.init();
    assert.equal(reloaded.state.bookmarks.length, store.state.bookmarks.length, '分片存储读回后书签数量必须一致');

    const trimmed = store.state.bookmarks.filter((bookmark) => String(bookmark.name).startsWith('站点'));
    for (const bookmark of trimmed) await store.deleteBookmark(bookmark.id);
    assert.equal(syncData[BOOKMARK_CHUNKS_KEY], 1);
    assert.equal(bookmarkChunkKey(1) in syncData, false, '书签减少后多余的分片应被清理');

    await assert.rejects(
        store.addBookmark({ name: 'Big icon', url: 'https://big.example/', icon: `data:image/png;base64,${'A'.repeat(5000)}`, folder: '全部' }),
        /图标过大/,
        '过大的内嵌图标会撑爆同步配额，必须拒绝'
    );

    const countBeforeFailure = store.state.bookmarks.length;
    failWrites = true;
    await assert.rejects(store.addBookmark({ name: 'D', url: 'https://d.example/', icon: '', folder: '全部' }), /quota exceeded/);
    failWrites = false;
    assert.equal(store.state.bookmarks.length, countBeforeFailure, '写入失败时内存状态必须回滚');
}

/** 加载时就修掉串号图标，不依赖用户手动点「修复图标」。 */
async function testSharedIconAutoRepair(): Promise<void> {
    const jd = 'https://infinityicon.infinitynewtab.com/user-share-icon/cee009549b352def723ba09d6da4b742.png';
    // 上一个用例留下了分片键，先清掉，避免 decodeBookmarks 读到旧数据。
    Object.keys(syncData)
        .filter((key) => key === 'bookmarks' || key === 'bookmarkChunks' || key.startsWith('bookmarks.'))
        .forEach((key) => delete syncData[key]);
    Object.assign(syncData, {
        bookmarks: [
            { id: 1, name: 'A', url: 'https://a.example/', icon: jd, folder: '全部', order: 0 },
            { id: 2, name: 'B', url: 'https://b.other.com/', icon: jd, folder: '全部', order: 1 },
            { id: 3, name: 'C', url: 'https://c.other.com/', icon: 'https://c.other.com/icon.png', folder: '全部', order: 2 }
        ],
        folders: ['全部'],
        settings: sanitizeSettings({}),
        recentSearches: []
    });
    const store = new AppStore();
    await store.init();
    assert.equal(store.state.bookmarks.filter((bookmark) => bookmark.icon === '').length, 2, '跨站共用的图标必须在加载时就清掉');
    assert.equal(store.state.bookmarks[2].icon, 'https://c.other.com/icon.png', '正常图标不能被误伤');

    for (let attempt = 0; attempt < 50 && !Array.isArray(syncData['bookmarks.0']); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const written = (syncData['bookmarks.0'] ?? []) as Array<{ name: string; icon: string }>;
    assert.equal(written.length, 3, '修复结果要写回同步存储');
    assert.equal(written.filter((bookmark) => bookmark.icon === '').length, 2, '存储里也必须是修好的');
}

/**
 * 官方备份把同一个 id 发给完全不同的站点。按 id 的 find / findIndex 只会命中
 * 第一条，于是「编辑任何一条书签都是同一条」，deleteBookmark 还会误删同 id 的全部。
 */
async function testDuplicateIdRepair(): Promise<void> {
    const same = '6dcbbe4e9dc6ef2fd68da7d8befd117c';
    const repaired = sanitizeBookmarks([
        { id: same, name: 'A', url: 'https://a.example/', folder: '全部', order: 0 },
        { id: same, name: 'B', url: 'https://b.example/', folder: '全部', order: 1 },
        { id: same, name: 'C', url: 'https://c.example/', folder: '全部', order: 2 },
        { id: 7, name: 'N', url: 'https://n.example/', folder: '全部', order: 3 }
    ]);
    assert.equal(repaired.length, 4, '撞号不能丢书签');
    assert.equal(new Set(repaired.map((bookmark) => String(bookmark.id))).size, 4, '修复后 id 必须互不相同');
    assert.equal(repaired[0].id, same, '首次出现的 id 要保留');
    assert.ok(
        repaired.slice(1).every((bookmark) => String(bookmark.id) !== String(same)),
        '后续撞号记录必须换成新 id'
    );
    assert.equal(
        sanitizeBookmarks([
            { id: same, name: 'B', url: 'https://b.example/' },
            { id: same, name: 'C', url: 'https://c.example/' }
        ])[1].id,
        repaired[2].id,
        '派生 id 要稳定，刷新后不能漂移'
    );

    // 撞号的 id 同样要在加载时写回存储，并保证 deleteBookmark 不再误删同 id 记录。
    Object.keys(syncData)
        .filter((key) => key === 'bookmarks' || key === 'bookmarkChunks' || key.startsWith('bookmarks.'))
        .forEach((key) => delete syncData[key]);
    Object.assign(syncData, {
        bookmarks: [
            { id: same, name: 'A', url: 'https://a.example/', folder: '全部', order: 0 },
            { id: same, name: 'B', url: 'https://b.example/', folder: '全部', order: 1 },
            { id: same, name: 'C', url: 'https://c.example/', folder: '全部', order: 2 },
            { id: 7, name: 'N', url: 'https://n.example/', folder: '全部', order: 3 }
        ],
        folders: ['全部'],
        settings: sanitizeSettings({}),
        recentSearches: []
    });
    const store = new AppStore();
    await store.init();
    assert.equal(new Set(store.state.bookmarks.map((bookmark) => String(bookmark.id))).size, 4, '内存里也不能有重复 id');

    for (let attempt = 0; attempt < 50 && !Array.isArray(syncData['bookmarks.0']); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const written = (syncData['bookmarks.0'] ?? []) as Array<{ id: string | number; url: string }>;
    assert.equal(written.length, 4, '撞号修复要写回同步存储');
    assert.equal(new Set(written.map((bookmark) => String(bookmark.id))).size, 4, '存储里也不能有重复 id');

    await store.deleteBookmark(written[1].id);
    assert.equal(store.state.bookmarks.length, 3, '删除一条只能删掉一条');
    assert.ok(!store.state.bookmarks.some((bookmark) => bookmark.url === 'https://b.example/'), '删掉的就是 b');
    assert.ok(store.state.bookmarks.some((bookmark) => bookmark.url === 'https://a.example/'), '同 id 的其他书签不能被一起删掉');
}

/** 「从常访问移除」只写屏蔽名单并持久化，恢复时一次性清掉全部。 */
async function testRecentExclusion(): Promise<void> {
    Object.keys(syncData)
        .filter((key) => key === 'bookmarks' || key === 'bookmarkChunks' || key.startsWith('bookmarks.'))
        .forEach((key) => delete syncData[key]);
    Object.assign(syncData, {
        bookmarks: [],
        folders: ['全部'],
        settings: sanitizeSettings({}),
        recentSearches: []
    });
    const store = new AppStore();
    await store.init();
    assert.deepEqual(store.state.settings.layout.recentExcluded, [], '新装状态应没有屏蔽项');

    assert.equal(await store.removeRecentSite('  YouTube.com '), true, '首次移除要写入名单');
    assert.equal(await store.removeRecentSite('youtube.com'), false, '重复移除不能写入两次');
    assert.equal(await store.removeRecentSite(''), false, '空 host 要拒绝');
    assert.deepEqual(store.state.settings.layout.recentExcluded, ['youtube.com'], '写入的 host 要转小写并去掉首尾空白');

    for (let attempt = 0; attempt < 50 && !(syncData.settings as { layout?: { recentExcluded?: unknown } })?.layout?.recentExcluded; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual((syncData.settings as { layout: { recentExcluded: string[] } }).layout.recentExcluded, ['youtube.com'], '屏蔽名单要写回同步存储');

    assert.equal(await store.restoreRecentSites(), 1, '恢复要返回找回的站点数');
    assert.deepEqual(store.state.settings.layout.recentExcluded, [], '恢复后要清空名单');
    assert.equal(await store.restoreRecentSites(), 0, '名单为空时恢复不能产生写入');
}

/** 账密只存本机；地址和文件名都要收敛成服务器能寻址的形态。 */
async function testWebDavAccount(): Promise<void> {
    assert.deepEqual(sanitizeWebDavAccount({ url: 'https://dav.example.com/a/b/' }), {
        url: 'https://dav.example.com/a/b',
        username: '',
        password: '',
        file: DEFAULT_WEBDAV_FILE
    }, '地址要裁掉尾部斜杠');
    assert.deepEqual(sanitizeWebDavAccount({ url: 'https://user:secret@example.com/' }), {
        url: 'https://example.com',
        username: '',
        password: '',
        file: DEFAULT_WEBDAV_FILE
    }, '地址里内嵌的账密必须剥掉，改走 Basic 头');
    assert.equal(sanitizeWebDavAccount({ url: 'ftp://example.com/' }).url, '', '非 http(s) 地址要拒绝');
    assert.deepEqual(sanitizeWebDavAccount({ url: 'not a url', username: '  admin  ', file: '../escape' }), {
        url: '',
        username: 'admin',
        password: '',
        file: DEFAULT_WEBDAV_FILE
    }, '非法地址清空、账户去首尾空白、越界文件名回落默认值');
    assert.equal(webDavHref(sanitizeWebDavAccount({ url: 'https://dav.example.com/a', file: 'b.json' })), 'https://dav.example.com/a/b.json');

    await saveWebDavAccount(sanitizeWebDavAccount({ url: 'https://dav.example.com/', username: 'me', password: 'secret', file: 'backup.json' }));
    assert.deepEqual(await loadWebDavAccount(), {
        url: 'https://dav.example.com',
        username: 'me',
        password: 'secret',
        file: 'backup.json'
    }, '保存后要能完整读回');
    assert.equal(syncData.webdav, undefined, '账密不能写进同步存储');
    assert.deepEqual(localData.webdav, { url: 'https://dav.example.com', username: 'me', password: 'secret', file: 'backup.json' });

    const seen: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response('created', { status: 201, statusText: 'Created' });
    }) as typeof fetch;
    try {
        const account = { url: 'https://dav.example.com', username: 'me', password: 'secret', file: 'backup.json' };
        await uploadBackup(account, { version: '2.0', data: { bookmarks: [] } });
        assert.equal(seen.length, 1, '上传只发一次请求');
        assert.equal(seen[0].url, 'https://dav.example.com/backup.json');
        assert.equal(seen[0].init.method, 'PUT');
        const headers = seen[0].init.headers as Record<string, string>;
        assert.equal(headers.Authorization, `Basic ${Buffer.from('me:secret', 'utf8').toString('base64')}`);
        assert.equal(headers['Content-Type'], 'application/json');
        assert.ok(seen[0].init.body instanceof Blob, '备份要作为 Blob 上传');
        assert.equal(await (seen[0].init.body as Blob).text(), '{"version":"2.0","data":{"bookmarks":[]}}');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

/** 扩展页面受同源策略限制，真正的请求要交给持有 host 权限的后台 worker。 */
async function testWebDavBackgroundBridge(): Promise<void> {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes))), Array.from(bytes), 'base64 要能无损往返');

    assert.equal(usesBackgroundChannel('https://dav.example.com'), false, '没有权限检查接口时只能页面直连');
    assert.equal(
        await ensureWebDavAccess({ url: 'https://dav.example.com', username: 'me', password: 'secret', file: 'b.json' }),
        false,
        '没有 permissions 接口时授权要静默失败'
    );

    const account = { url: 'https://dav.example.com/dav', username: 'me', password: 'secret', file: 'b.json' };
    const messages: unknown[] = [];
    const requested: string[][] = [];
    const chromeAny = chrome as Record<string, unknown>;
    const previousPermissions = chromeAny.permissions;
    chromeAny.permissions = undefined;
    (chrome.runtime as Record<string, unknown>).hasHostPermission = ({ origins }: { origins: string[] }) => origins[0] === 'https://dav.example.com/*';
    (chrome.runtime as Record<string, unknown>).sendMessage = async (message: unknown) => {
        messages.push(message);
        return { ok: true, status: 204, body: null };
    };
    try {
        assert.equal(usesBackgroundChannel(account.url), true, '拿到 host 权限后要改走后台通道');
        assert.equal(await ensureWebDavAccess(account), true, '已有权限时不再弹窗请求');

        await uploadBackup(account, { version: '2.0', data: { bookmarks: [] } });
        await deleteBackup(account);
        assert.equal(messages.length, 2, '上传和删除各发一条后台消息');
        const upload = messages[0] as WebDavRequestMessage;
        const remove = messages[1] as WebDavRequestMessage;
        assert.equal(upload.type, WEBDAV_REQUEST_TYPE);
        assert.equal(upload.method, 'PUT');
        assert.equal(remove.method, 'DELETE');
        assert.equal(upload.url, 'https://dav.example.com/dav/b.json');
        assert.ok(upload.timeout > 0 && remove.timeout > 0, '请求要带上超时');
        assert.ok(upload.timeout > remove.timeout, '上传要给比删除更长的超时');
        assert.equal(upload.headers['Content-Type'], 'application/json');
        assert.equal(upload.headers.Authorization, `Basic ${Buffer.from('me:secret', 'utf8').toString('base64')}`);
        assert.equal(remove.headers.Authorization, upload.headers.Authorization);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(base64ToBytes(upload.body ?? ''))), {
            version: '2.0',
            data: { bookmarks: [] }
        }, '请求体要走 base64 无损往返');
        assert.equal(remove.body, null, '删除请求没有正文');

        assert.ok(isWebDavRequestMessage(upload));
        assert.ok(!isWebDavRequestMessage({ type: 'other' }), '类型不匹配的消息要被拒收');
        assert.ok(!isWebDavRequestMessage({ type: WEBDAV_REQUEST_TYPE, method: 'PUT', url: 'x', timeout: 1 }), '缺字段的消息要被拒收');
        assert.ok(isWebDavResponseMessage({ ok: true, status: 201, body: null }));
        assert.ok(isWebDavResponseMessage({ error: 'boom' }));
        assert.ok(!isWebDavResponseMessage({ status: 201 }), '缺 ok 的回执要被拒收');

        // 权限被撤销后要能通过 permissions API 重新申请。
        (chrome.runtime as Record<string, unknown>).hasHostPermission = () => false;
        chromeAny.permissions = { request: async ({ origins }: { origins: string[] }) => { requested.push(origins); return true; } };
        assert.equal(await ensureWebDavAccess(account), true, '重新授权要成功');
        assert.deepEqual(requested, [['https://dav.example.com/*']], '只申请目标服务器这一个来源，且要带 match pattern 的路径');
    } finally {
        delete (chrome.runtime as Record<string, unknown>).hasHostPermission;
        delete (chrome.runtime as Record<string, unknown>).sendMessage;
        chromeAny.permissions = previousPermissions;
    }
}

testTransactions()
    .then(testSharedIconAutoRepair)
    .then(testDuplicateIdRepair)
    .then(testRecentExclusion)
    .then(testWebDavAccount)
    .then(testWebDavBackgroundBridge)
    .then(() => console.log('TypeScript core tests passed.'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
