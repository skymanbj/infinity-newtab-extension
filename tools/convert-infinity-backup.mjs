#!/usr/bin/env node
/**
 * Infinity New Tab 官方备份（.infinity）→ 本扩展 2.0 JSON 转换器
 *
 * 官方扩展（Infinity Pro v11.x）的备份是 {version:"v2", data:{site:{sites:[[...]]}, ...}}，
 * 本扩展只认 {version:"2.0", data:{bookmarks:[...], folders, settings}}。
 * 直接导入官方文件不会报错，但会把数据清空，所以必须先跑这个脚本。
 *
 * 用法：
 *   node tools/convert-infinity-backup.mjs <input.infinity> [选项]
 *
 * 选项：
 *   --out <path>      输出路径，默认 <输入目录>/infinity-newtab-backup-<日期>.json
 *   --pages           按官方分页拆成「第 N 页」文件夹（默认全部放进「全部」）
 *   --no-wallpaper    不迁移壁纸，保持默认渐变
 *   --quiet           只输出结果路径
 *
 * 默认不拆文件夹：「全部」是一个真实文件夹而不是聚合视图，Dock 只读它，
 * 拆页会让 Dock 和「全部」标签变空。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ICON_MAX = 4096;
const NAME_MAX = 160;
const FOLDER_MAX = 80;

/** 官方内置应用页没有等价的网页地址，能映射的映射，其余丢弃。 */
const APP_TARGETS = new Map([
    ['gmail', 'https://mail.google.com/']
]);

const ENGINES = new Map([
    ['google', 'google'],
    ['谷歌', 'google'],
    ['bing', 'bing'],
    ['必应', 'bing'],
    ['baidu', 'baidu'],
    ['百度', 'baidu'],
    ['duckduckgo', 'duckduckgo']
]);

function parseArgs(argv) {
    const options = { input: '', out: '', splitPages: false, wallpaper: true, quiet: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--out') options.out = argv[++index] ?? '';
        else if (arg === '--pages') options.splitPages = true;
        else if (arg === '--no-wallpaper') options.wallpaper = false;
        else if (arg === '--quiet') options.quiet = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (!arg.startsWith('-')) options.input = arg;
    }
    return options;
}

function text(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 官方 target 可能是 infinity:// 应用页、带尾空格的地址或缺少协议的域名。 */
function normalizeTarget(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { url: '', reason: '没有网址' };
    const app = /^infinity:\/\/([^/?#]+)/i.exec(value);
    if (app) {
        const mapped = APP_TARGETS.get(app[1].toLowerCase());
        return mapped
            ? { url: mapped, reason: '' }
            : { url: '', reason: `官方内置页 ${value} 没有网页地址` };
    }
    const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
    let url;
    try {
        url = new URL(candidate);
    } catch {
        return { url: '', reason: `网址无法解析：${value}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { url: '', reason: `不支持的协议：${value}` };
    }
    if (!url.hostname) return { url: '', reason: `缺少域名：${value}` };
    return { url: url.href, reason: '' };
}

function iconOf(item) {
    const raw = typeof item.bgImage === 'string' ? item.bgImage.trim() : '';
    if (!raw) return '';
    if (raw.startsWith('data:image/')) return raw.length > ICON_MAX ? '' : raw;
    if (raw.startsWith('https://')) return raw;
    // 本扩展只接受 https 图标，http 图标升级协议后基本仍可用。
    if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`;
    return '';
}

function canonical(url) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
}

/** 粗粒度站点键：同一站点的不同子域视为一个，用于判断图标是否被跨站复用。 */
function siteKey(url) {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    // 二级后缀（co.uk、com.cn 等）取三段，避免把不同站点误判成同一站。
    const twoLevel = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
    const take = parts.length >= 3 && twoLevel.test(parts.slice(-2).join('.')) ? 3 : 2;
    return parts.slice(-take).join('.');
}

/**
 * 官方备份里出现过同一个图标 URL 被十几个毫不相关的站点共用的情况
 * （user-share-icon 的 ID 串号，现在解析出来是京东的 logo）。
 * 这种图标一定是错的，清空后交给扩展按域名取 favicon，比留着错误图标好。
 */
function dropSharedIcons(bookmarks, report) {
    const usage = new Map();
    bookmarks.forEach((bookmark) => {
        if (!bookmark.icon) return;
        const sites = usage.get(bookmark.icon) ?? new Set();
        sites.add(siteKey(bookmark.url));
        usage.set(bookmark.icon, sites);
    });
    const broken = new Set(
        [...usage.entries()].filter(([, sites]) => sites.size > 1).map(([icon]) => icon)
    );
    if (!broken.size) return;
    const dropped = [];
    bookmarks.forEach((bookmark) => {
        if (!bookmark.icon || !broken.has(bookmark.icon)) return;
        dropped.push(bookmark.name);
        bookmark.icon = '';
    });
    report.sharedIcons = { count: broken.size, bookmarks: dropped.length, sample: dropped.slice(0, 5) };
}

/** 官方壁纸是云端 https 地址，本扩展用 preset + 远程地址即可直接显示。 */
function mapWallpaper(wallpaper) {
    if (!wallpaper || typeof wallpaper !== 'object') return null;
    const raw = [wallpaper.rawUrl, wallpaper.url]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value.startsWith('https://'));
    if (!raw) return null;
    return { type: 'preset', value: raw };
}

/** 官方用浅色文字（如 #ddd）时对应本扩展的 dark 主题，反之 light。 */
function mapTheme(setting) {
    const color = setting?.font?.color;
    const match = typeof color === 'string' ? /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color) : null;
    if (!match) return 'auto';
    const [red, green, blue] = match.slice(1, 4).map(Number);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance > 0.58 ? 'dark' : 'light';
}

function mapSearchEngine(searcher) {
    const name = searcher?.searchEngine?.current?.name;
    return ENGINES.get(String(name ?? '').trim().toLowerCase()) ?? 'google';
}

function convert(raw, options) {
    if (!raw || typeof raw !== 'object' || !raw.data || typeof raw.data !== 'object') {
        throw new Error('不是 Infinity 官方备份文件（缺少 data 字段）');
    }
    const pages = raw.data?.site?.sites;
    if (!Array.isArray(pages)) {
        throw new Error('备份里没有 site.sites，无法读取书签');
    }

    const report = { total: 0, kept: 0, duplicates: [], skipped: [], folders: [], sharedIcons: null, multiPage: pages.length > 1 };
    const bookmarks = [];
    const seen = new Set();
    const folders = ['全部'];

    pages.forEach((page, pageIndex) => {
        const items = Array.isArray(page) ? page : [];
        // 默认不拆页：「全部」是真实文件夹，拆页会让 Dock 和「全部」标签空着。
        const folder = options.splitPages && pages.length > 1
            ? text(`第 ${pageIndex + 1} 页`, FOLDER_MAX) || '全部'
            : '全部';
        if (folder !== '全部' && !folders.includes(folder)) folders.push(folder);

        items.forEach((item) => {
            report.total += 1;
            if (!item || typeof item !== 'object') {
                report.skipped.push({ name: '(空项)', reason: '条目不是对象' });
                return;
            }
            const { url, reason } = normalizeTarget(item.target);
            if (!url) {
                report.skipped.push({ name: text(item.name, NAME_MAX) || '(未命名)', reason });
                return;
            }
            const key = `${folder}|${canonical(url)}`;
            if (seen.has(key)) {
                report.duplicates.push({ name: text(item.name, NAME_MAX), url, folder });
                return;
            }
            seen.add(key);

            let name = text(item.name, NAME_MAX);
            if (!name) name = new URL(url).hostname;
            bookmarks.push({
                id: text(item.uuid, 80) || text(item.id, 80) || `infinity-${pageIndex}-${bookmarks.length}`,
                name,
                url,
                icon: iconOf(item),
                folder,
                order: bookmarks.filter((bookmark) => bookmark.folder === folder).length
            });
            report.kept += 1;
        });
    });

    const setting = raw.data?.setting?.setting ?? {};
    const wallpaper = options.wallpaper ? mapWallpaper(raw.data?.wallpaper) : null;

    dropSharedIcons(bookmarks, report);

    const settings = {
        layout: {
            showClock: true,
            showSearch: setting?.search?.hide !== true,
            showBookmarks: true,
            showStatus: true,
            showRecent: true,
            openInNewTab: false,
            searchEngine: mapSearchEngine(raw.data?.searcher),
            // 跟随扩展默认值（Dock 显示常访问），不要用官方备份里的布局概念覆盖它。
            dockSource: 'recent',
            dockSize: 56,
            dockMagnify: true,
            saveSearches: setting?.search?.searchSuggest !== false,
            backupReminder: true
        },
        wallpaper: {
            type: wallpaper?.type ?? 'gradient',
            value: wallpaper?.value ?? '',
            blur: 0,
            // 官方的 opacity 是壁纸图层不透明度，和这里的暗化不是同一个量，不做换算。
            overlay: 0,
            idleHide: true,
            pauseOnBattery: true,
            pauseWhenHidden: true,
            sound: false
        },
        appearance: {
            clockFormat: '24h',
            dateFormat: 'long',
            enhancedAnimations: setting?.animation?.easing !== 'none',
            hdrHighlights: true,
            theme: mapTheme(setting),
            glass: 'clear',
            reduceTransparency: false
        }
    };

    const todos = Array.isArray(raw.data?.todo?.todoList)
        ? raw.data.todo.todoList
            .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
            .map((entry, index) => ({
                id: text(entry.todoId, 80) || `infinity-todo-${index}`,
                text: text(entry.text, 500),
                done: entry.done === true,
                createdAt: Number(entry.time) || Date.now()
            }))
        : [];

    report.folders = folders;
    report.wallpaper = wallpaper?.value ?? null;
    report.todos = todos.length;
    report.ignored = [
        Array.isArray(raw.data?.note?.list) && raw.data.note.list.some((note) => text(note?.content, 1))
            ? '便签（note）'
            : '',
        Array.isArray(raw.data?.weather?.list) && raw.data.weather.list.length ? '天气缓存（weather）' : '',
        setting?.layout?.pagin ? '官方分页布局（layout.pagin）' : '',
        setting?.view?.windmill ? '官方风车组件（view.windmill）' : ''
    ].filter(Boolean);

    const data = { bookmarks, folders, settings };
    if (todos.length) data.todos = todos;

    return {
        backup: {
            version: '2.0',
            exportDate: new Date().toISOString(),
            data
        },
        report
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.input) {
        console.log('用法: node tools/convert-infinity-backup.mjs <input.infinity> [--out 文件.json] [--pages] [--no-wallpaper]');
        process.exit(options.help ? 0 : 1);
    }

    const inputPath = resolve(options.input);
    let raw;
    try {
        raw = JSON.parse(readFileSync(inputPath, 'utf8'));
    } catch (error) {
        console.error(`读取失败：${error instanceof Error ? error.message : error}`);
        process.exit(1);
    }

    let result;
    try {
        result = convert(raw, options);
    } catch (error) {
        console.error(`转换失败：${error instanceof Error ? error.message : error}`);
        process.exit(1);
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = resolve(options.out || join(dirname(inputPath), `infinity-newtab-backup-${stamp}.json`));
    writeFileSync(outPath, `${JSON.stringify(result.backup, null, 2)}\n`, 'utf8');

    if (options.quiet) {
        console.log(outPath);
        return;
    }

    const { report } = result;
    console.log(`来源：${basename(inputPath)}（官方 ${raw.extVersion ?? '未知版本'}，${report.multiPage ? `${raw.data.site.sites.length} 页` : '单页'}）`);
    console.log(`书签：${report.total} 条中保留 ${report.kept} 条，跳过 ${report.skipped.length} 条，去重 ${report.duplicates.length} 条`);
    if (report.skipped.length) {
        report.skipped.forEach((entry) => console.log(`  - 跳过 ${entry.name}：${entry.reason}`));
    }
    if (report.duplicates.length) {
        report.duplicates.forEach((entry) => console.log(`  - 重复 ${entry.name}：${entry.url}`));
    }
    console.log(`文件夹：${report.folders.join(' / ')}`);
    if (report.sharedIcons) {
        console.log(`图标：${report.sharedIcons.count} 个图标被不同站点共用（源数据串号），已改为按域名自动取 favicon，涉及 ${report.sharedIcons.bookmarks} 条`);
    }
    if (options.splitPages && report.multiPage) {
        console.log('注意：「全部」为空，Dock 和「全部」标签会空着，需要在启动台里拖动书签补进去。');
    }
    console.log(`壁纸：${report.wallpaper ?? '未迁移（保持默认渐变）'}`);
    if (report.todos) console.log(`待办：${report.todos} 条已随备份保留（本扩展界面不显示待办）`);
    if (report.ignored.length) console.log(`未迁移：${report.ignored.join('、')}`);
    console.log(`输出：${outPath}`);
    console.log('下一步：设置 → 数据 → 导入，选择上面这个 .json 文件。');
}

main();
