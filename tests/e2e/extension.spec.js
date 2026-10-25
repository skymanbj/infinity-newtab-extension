const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

const initialData = {
    bookmarks: [
        { id: 1, name: 'www.google.com', url: 'https://www.google.com/', icon: '', folder: '全部', order: 0 },
        { id: 2, name: 'GitHub', url: 'https://github.com/', icon: '', folder: '全部', order: 1 },
        { id: 3, name: 'Bilibili', url: 'https://www.bilibili.com/', icon: '', folder: 'POM', order: 0 }
    ],
    folders: ['全部', 'POM'],
    settings: {
        layout: { showClock: true, showSearch: true, showBookmarks: true, showStatus: true, showRecent: true, searchEngine: 'google', dockSource: 'bookmarks' },
        wallpaper: { type: 'gradient', value: '', blur: 0, overlay: 30, idleHide: false },
        appearance: { clockFormat: '24h', dateFormat: 'long', enhancedAnimations: true, theme: 'light' }
    },
    recentSearches: ['二次元壁纸'],
    lastBackupPrompt: 4102444800000
};

const historyItems = [
    { url: 'https://www.youtube.com/watch?v=1', visitCount: 8, lastVisitTime: 300 },
    { url: 'https://www.youtube.com/watch?v=2', visitCount: 5, lastVisitTime: 200 },
    { url: 'https://www.v2ex.com/t/1', visitCount: 4, lastVisitTime: 100 },
    { url: 'https://www.google.com/search?q=noise', visitCount: 99, lastVisitTime: 400 }
];

async function installChromeMock(page, seed = initialData, options = {}) {
    await page.addInitScript(({ seed, history, options }) => {
        const syncKey = 'infinity-e2e-sync';
        const localKey = 'infinity-e2e-local';
        if (!sessionStorage.getItem('infinity-e2e-ready')) {
            localStorage.setItem(syncKey, JSON.stringify(seed));
            localStorage.setItem(localKey, '{}');
            sessionStorage.setItem('infinity-e2e-ready', '1');
        }
        const readArea = (key) => JSON.parse(localStorage.getItem(key) || '{}');
        const writeArea = (key, value) => localStorage.setItem(key, JSON.stringify(value));
        const selectKeys = (data, keys) => {
            if (keys === null || keys === undefined) return { ...data };
            if (typeof keys === 'string') return { [keys]: data[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data[key]]));
            return {};
        };
        const storageArea = (key) => ({
            get(keys, callback) { callback(selectKeys(readArea(key), keys)); },
            set(values, callback = () => {}) { writeArea(key, { ...readArea(key), ...values }); callback(); },
            remove(keys, callback = () => {}) {
                const data = readArea(key);
                for (const name of Array.isArray(keys) ? keys : [keys]) delete data[name];
                writeArea(key, data);
                callback();
            },
            clear(callback = () => {}) { writeArea(key, {}); callback(); }
        });
        Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 8 });
        Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
        navigator.getBattery = async () => ({ level: 0.82, charging: false });
        if (options.failIndexedDB) {
            Object.defineProperty(indexedDB, 'open', {
                configurable: true,
                value() { throw new DOMException('模拟 IndexedDB 失败', 'InvalidStateError'); }
            });
        }
        const openedTabs = [];
        window.chrome = {
            runtime: { id: 'e2e-infinity-newtab', lastError: null, getURL: () => `${location.origin}/icons/icon-48.png` },
            storage: { sync: storageArea(syncKey), local: storageArea(localKey) },
            tabs: {
                query(_query, callback) { callback([]); },
                update() {},
                create(properties) { openedTabs.push(properties); return Promise.resolve({ id: openedTabs.length, ...properties }); }
            },
            downloads: { search(_query, callback) { callback([]); }, show() {} },
            history: { search(_query, callback) { callback(history); } }
        };
        window.__readMockSync = () => {
            const data = readArea(syncKey);
            // Mirror src/core/bookmark-storage.ts so assertions see one logical list.
            if (Number.isInteger(data.bookmarkChunks)) {
                data.bookmarks = Array.from({ length: data.bookmarkChunks }, (_, index) => data[`bookmarks.${index}`] || []).flat();
            }
            return data;
        };
        window.__readRawSync = () => readArea(syncKey);
        window.__readMockLocal = () => readArea(localKey);
        window.__readOpenedTabs = () => [...openedTabs];
        window.__webdav = {
            file: options.fetchMock?.file ? { text: options.fetchMock.file, name: 'infinity-newtab-backup.json' } : null,
            requests: [],
            permissionRequests: [],
            channel: 'page'
        };
        if (options.fetchMock) {
            // 页面直连和后台 worker 共用这一个 handler，好让两条通道的行为可对比。
            const handleWebDav = async (url, init = {}) => {
                const webdav = window.__webdav;
                const method = init.method || 'GET';
                const text = init.body instanceof Blob ? await init.body.text()
                    : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body)
                        : init.body == null ? '' : String(init.body);
                webdav.requests.push({
                    url: String(url),
                    method,
                    via: webdav.channel,
                    headers: init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers || {}) },
                    text
                });
                if (method === 'PUT') {
                    webdav.file = { text, name: String(url).split('/').pop() };
                    return new Response('created', { status: 201, statusText: 'Created' });
                }
                if (method === 'DELETE') {
                    const existed = Boolean(webdav.file);
                    webdav.file = null;
                    // 204 的响应体必须为空，传 '' 会让 Response 构造直接抛错。
                    return new Response(null, { status: existed ? 204 : 404 });
                }
                if (method === 'PROPFIND') {
                    if (!webdav.file) return new Response('', { status: 404 });
                    return new Response(
                        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${String(url)}</d:href>` +
                        `<d:propstat><d:prop><d:displayname>${String(url).split('/').pop()}</d:displayname>` +
                        `<d:getcontentlength>${webdav.file.text.length}</d:getcontentlength>` +
                        '<d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified></d:prop>' +
                        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
                        { status: 207, statusText: 'Multi-Status' }
                    );
                }
                if (method === 'GET') {
                    if (!webdav.file) return new Response('', { status: 404 });
                    return new Response(webdav.file.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                return new Response('', { status: 405 });
            };
            window.fetch = (url, init) => handleWebDav(url, init);
            if (options.backgroundMock) {
                // 初始没有权限，用户点「保存并测试」授权后才放行 —— 和真实流程一致。
                let granted = false;
                window.chrome.runtime.hasHostPermission = ({ origins = [] }) => granted && origins.length > 0;
                window.chrome.permissions = {
                    request: async ({ origins = [] }) => {
                        // Chrome 的 match pattern 必须带路径，裸 origin 会抛 "Empty path"。
                        for (const origin of origins) {
                            if (origin === new URL(origin).origin) {
                                throw new Error(`Invalid value for origin pattern ${origin}: Empty path.`);
                            }
                        }
                        window.__webdav.permissionRequests.push([...origins]);
                        granted = true;
                        return true;
                    }
                };
                window.chrome.runtime.sendMessage = async (message) => {
                    if (!message || message.type !== 'infinity-newtab-webdav-request') return undefined;
                    window.__webdav.channel = 'background';
                    const response = await handleWebDav(message.url, {
                        method: message.method,
                        headers: message.headers,
                        body: message.body ? Uint8Array.from(atob(message.body), (char) => char.charCodeAt(0)) : undefined
                    });
                    window.__webdav.channel = 'page';
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    let binary = '';
                    for (const byte of bytes) binary += String.fromCharCode(byte);
                    return { ok: response.ok, status: response.status, body: bytes.length ? btoa(binary) : null };
                };
            }
        }
    }, { seed, history: options.history ?? historyItems, options });
}

async function openExtension(page, seed = initialData, options = {}) {
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await installChromeMock(page, seed, options);
    await page.goto('/newtab.html');
    // The Dock follows dockSource: frequent sites by default, pinned bookmarks when chosen or when history is off.
    const layout = seed.settings?.layout ?? {};
    if (layout.dockSource === 'bookmarks' || layout.showRecent === false) {
        await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(Math.min(12, seed.bookmarks.filter((bookmark) => (bookmark.folder || '全部') === '全部').length));
    } else {
        await expect(page.locator('.dock-item[data-site-index]').first()).toBeVisible();
    }
    return errors;
}

async function centerOf(locator) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function inspectArticleFilter(page, locator) {
    await locator.hover();
    const lens = page.locator('.liquid-glass-lens');
    await expect(lens).toHaveClass(/is-visible/);
    await expect.poll(() => lens.getAttribute('data-liquid-filter-id')).toBeTruthy();
    const info = await page.evaluate(() => {
        const lens = document.querySelector('.liquid-glass-lens');
        const id = lens?.dataset.liquidFilterId;
        const filter = id ? document.getElementById(id) : null;
        const rect = lens?.getBoundingClientRect();
        const magnifying = filter?.querySelector('feImage[data-optical-map="magnifying"]');
        const displacement = filter?.querySelector('feImage[data-optical-map="displacement"]');
        const specular = filter?.querySelector('feImage[data-optical-map="specular"]');
        const scales = [...(filter?.querySelectorAll('feDisplacementMap') || [])].map((node) => Number(node.getAttribute('scale')));
        const maximum = Number(filter?.dataset.maximumDisplacement || 0);
        return {
            id,
            width: Math.round(rect?.width || 0),
            height: Math.round(rect?.height || 0),
            backdrop: lens ? getComputedStyle(lens).backdropFilter : '',
            lensText: lens?.textContent,
            lensChildren: lens?.children.length,
            magnifyingWidth: Number(magnifying?.getAttribute('width')),
            magnifyingHeight: Number(magnifying?.getAttribute('height')),
            magnifyingHref: magnifying?.getAttribute('href'),
            displacementWidth: Number(displacement?.getAttribute('width')),
            displacementHeight: Number(displacement?.getAttribute('height')),
            displacementHref: displacement?.getAttribute('href'),
            specularWidth: Number(specular?.getAttribute('width')),
            specularHeight: Number(specular?.getAttribute('height')),
            specularHref: specular?.getAttribute('href'),
            compositeCount: filter?.querySelectorAll('feComposite').length,
            transferCount: filter?.querySelectorAll('feComponentTransfer').length,
            blendCount: filter?.querySelectorAll('feBlend').length,
            nodeOrder: filter ? [...filter.children].map((node) => node.tagName.toLowerCase()) : [],
            xChannel: filter?.querySelector('feDisplacementMap')?.getAttribute('xChannelSelector'),
            yChannel: filter?.querySelector('feDisplacementMap')?.getAttribute('yChannelSelector'),
            blur: filter?.querySelector('feGaussianBlur')?.getAttribute('stdDeviation'),
            saturation: filter?.querySelector('feColorMatrix')?.getAttribute('values'),
            specularOpacity: filter?.querySelector('feFuncA')?.getAttribute('slope'),
            scales,
            maximum
        };
    });
    expect(info.id).toBeTruthy();
    expect(info.backdrop).toContain(info.id);
    expect(info.lensText).toBe('');
    expect(info.lensChildren).toBe(0);
    expect(info.magnifyingWidth).toBe(info.width);
    expect(info.magnifyingHeight).toBe(info.height);
    expect(info.magnifyingHref).toMatch(/^data:image\/png;base64,/);
    expect(info.displacementWidth).toBe(info.width);
    expect(info.displacementHeight).toBe(info.height);
    expect(info.specularWidth).toBe(info.width);
    expect(info.specularHeight).toBe(info.height);
    expect(info.displacementHref).toMatch(/^data:image\/png;base64,/);
    expect(info.specularHref).toMatch(/^data:image\/png;base64,/);
    expect(info.compositeCount).toBe(1);
    expect(info.transferCount).toBe(1);
    expect(info.blendCount).toBe(2);
    expect(info.nodeOrder).toEqual([
        'feimage',
        'fedisplacementmap',
        'fegaussianblur',
        'feimage',
        'fedisplacementmap',
        'fecolormatrix',
        'feimage',
        'fecomposite',
        'fecomponenttransfer',
        'feblend',
        'feblend'
    ]);
    expect(info.xChannel).toBe('R');
    expect(info.yChannel).toBe('G');
    expect(Number(info.blur)).toBeCloseTo(0, 2);
    expect(Number(info.saturation)).toBeCloseTo(9, 2);
    expect(Number(info.specularOpacity)).toBeCloseTo(0.5, 2);
    expect(info.maximum).toBeGreaterThan(30);
    expect(info.scales[0]).toBe(24);
    expect(info.scales[1] / info.maximum).toBeCloseTo(1, 2);
    return info;
}

async function expectRenderedRefraction(page, locator) {
    await locator.hover();
    const lens = page.locator('.liquid-glass-lens');
    await expect(lens).toHaveClass(/is-visible/);
    await expect.poll(() => lens.getAttribute('data-liquid-filter-id')).toBeTruthy();
    const displacement = page.locator('.liquid-filter-defs feDisplacementMap');
    const activeScales = await displacement.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('scale')));
    expect(activeScales.some((scale) => Number(scale) > 30)).toBe(true);
    const clip = await lens.boundingBox();
    expect(clip).not.toBeNull();
    await page.waitForTimeout(180);
    const active = await page.screenshot({ clip });
    const activeFilter = await lens.evaluate((element) => getComputedStyle(element).backdropFilter);
    await lens.evaluate((element) => element.style.setProperty('--liquid-filter', 'none'));
    await page.waitForTimeout(150);
    const neutral = await page.screenshot({ clip });
    expect(active.equals(neutral), 'SVG displacement must change rendered pixels').toBe(false);
    await lens.evaluate((element, filter) => element.style.setProperty('--liquid-filter', filter), activeFilter);
}

async function openLaunchpad(page, view = 'bookmarks') {
    await page.locator(view === 'recent' ? '.dock-recent' : '.dock-all').click();
    await expect(page.locator('.launchpad')).toBeVisible();
    if (view === 'recent') await expect(page.locator('.recent-tile').first()).toBeVisible();
}

async function openSettings(page, pane = 'appearance') {
    await page.locator('.settings-trigger').click();
    await expect(page.locator('.settings-window')).toHaveClass(/is-open/);
    if (pane !== 'appearance') await page.locator(`.settings-nav-item[data-pane="${pane}"]`).click();
    await expect(page.locator(`.settings-pane[data-pane="${pane}"]`)).toBeVisible();
}

function overlaps(a, b) {
    return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

test('renders the home screen, Dock and launchpad', async ({ page }) => {
    const errors = await openExtension(page);
    await expect(page).toHaveTitle('Infinity New Tab');
    await expect(page.locator('infinity-newtab-app')).toHaveCount(1);
    await expect(page.locator('.dock-item[data-bookmark-id]').first()).toHaveAttribute('aria-label', 'google.com');
    await expect(page.locator('.battery-capsule')).toContainText('82%');
    await expect(page.locator('.media-capsule, .download-capsule')).toHaveCount(0);
    await expect(page.locator('.hero-time')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator('wallpaper-badge')).toContainText('Twilight Bay');
    await expect(page.locator('.wallpaper-media .scene')).toHaveCount(1);

    await openLaunchpad(page);
    await expect(page.locator('.launchpad-tab[data-folder="全部"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.launchpad-tab[data-folder="全部"]')).toHaveText('全部 · 3');
    await expect(page.locator('.folder-tile[data-folder="POM"]')).toHaveCount(1);
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await expect(page.locator('.home')).toBeHidden();
    await page.locator('.launchpad-tab[data-view="recent"]').click();
    await expect(page.locator('.recent-tile')).toHaveCount(2);
    await expect(page.locator('.launchpad-grid')).toContainText('youtube.com');
    await expect(page.locator('.launchpad-grid')).not.toContainText('google');
    await page.locator('.launchpad-done').click();
    await expect(page.locator('bookmark-launchpad')).toBeHidden();

    await expect(page.locator('liquid-glass-system')).toHaveCount(1);
    const coverage = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-liquid-item]')];
        return {
            total: items.length,
            movedChildren: items.filter((item) => item.querySelector('.liquid-glass-content')).length,
            lenses: document.querySelectorAll('.liquid-glass-lens').length,
            hdrLayers: document.querySelectorAll('.hdr-glass-layer').length
        };
    });
    expect(coverage.total).toBeGreaterThan(10);
    expect(coverage.movedChildren).toBe(0);
    expect(coverage.lenses).toBe(1);
    expect(coverage.hdrLayers).toBe(1);
    expect(await page.locator('.hero-time').evaluate((element) => getComputedStyle(element).textShadow)).not.toBe('none');
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(1440);
    expect(errors).toEqual([]);
});

test('adds another extension page as a bookmark', async ({ page }) => {
    const errors = await openExtension(page);
    const extensionPage = 'chrome-extension://hjekpdhdabgkokjbklegnfkogcpjhhhg/index.html';
    await openLaunchpad(page);
    await page.locator('.add-bookmark').click();
    const dialog = page.getByRole('dialog', { name: '添加书签' });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="url"]').fill(extensionPage);
    await dialog.locator('input[name="name"]').fill('扩展工具');
    await dialog.getByRole('button', { name: '保存' }).click();
    const tile = page.locator('.bookmark-tile', { hasText: '扩展工具' });
    await expect(tile).toHaveAttribute('href', extensionPage);
    await tile.click();
    const openedTabs = await page.evaluate(() => window.__readOpenedTabs());
    expect(openedTabs).toEqual([{ url: extensionPage }]);
    await expect(page).toHaveURL(/\/newtab\.html$/);
    const stored = await page.evaluate(() => window.__readMockSync().bookmarks);
    expect(stored.some((bookmark) => bookmark.url === extensionPage)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dock-item[aria-label="扩展工具"]')).toHaveCount(1);
    expect(errors).toEqual([]);
});

test('uses one empty article precision lens over every real component', async ({ page }) => {
    const errors = await openExtension(page);
    const action = await inspectArticleFilter(page, page.locator('.shuffle-wallpaper'));
    const secondAction = await inspectArticleFilter(page, page.locator('.settings-trigger'));
    expect(secondAction.id).toBeTruthy();
    expect(action.id).toBeTruthy();

    const dockItem = await inspectArticleFilter(page, page.locator('.dock-item[data-bookmark-id="1"]'));
    expect(dockItem.id).toBeTruthy();
    await inspectArticleFilter(page, page.locator('.dock-all'));
    await inspectArticleFilter(page, page.locator('.search-pill'));

    await page.mouse.move(720, 600);
    await expect(page.locator('.liquid-glass-lens')).not.toHaveClass(/is-visible/, { timeout: 1000 });

    await openLaunchpad(page);
    await inspectArticleFilter(page, page.locator('.launchpad-tab[data-folder="POM"]'));
    await inspectArticleFilter(page, page.locator('.bookmark-tile[data-bookmark-id="1"]'));
    await inspectArticleFilter(page, page.locator('.add-bookmark'));
    expect(errors).toEqual([]);
});

test('renders real refraction pixels on hover', async ({ page }) => {
    const seed = structuredClone(initialData);
    seed.settings.appearance.enhancedAnimations = false;
    const errors = await openExtension(page, seed);
    await page.addStyleTag({ content: `
        body { background: repeating-linear-gradient(90deg, #101828 0 8px, #ff3f9f 8px 16px, #61d8ff 16px 24px) !important; }
        wallpaper-surface { display: none !important; }
        .search-pill, .dock, .dock-item .app-icon { transform: none !important; transition: none !important; }
    ` });
    await expectRenderedRefraction(page, page.locator('.search-pill'));
    await expectRenderedRefraction(page, page.locator('.dock-item[data-bookmark-id="2"]'));
    expect(errors).toEqual([]);
});

test('tracks the real pointer midway in both directions without flipping', async ({ page }) => {
    const errors = await openExtension(page);
    const first = page.locator('.shuffle-wallpaper');
    const second = page.locator('.settings-trigger');
    const from = await centerOf(first);
    const to = await centerOf(second);
    const midpoint = {
        x: (from.box.x + from.box.width + to.box.x) / 2,
        y: (from.y + to.y) / 2
    };
    const expectedProgress = (midpoint.x - from.x) / (to.x - from.x);
    await page.mouse.move(from.x, from.y);
    await page.mouse.move(midpoint.x, midpoint.y);
    const leftToRight = await page.locator('.liquid-glass-lens').evaluate((lens) => ({
        rect: lens.getBoundingClientRect().toJSON(),
        progress: Number(lens.dataset.liquidProgress),
        scaleX: new DOMMatrix(getComputedStyle(lens).transform).a,
        bridging: lens.classList.contains('is-bridging')
    }));
    const hdrGeometry = await page.locator('.hdr-glass-layer').evaluate((layer) => ({
        x: Number.parseFloat(layer.style.getPropertyValue('--hdr-glass-x')),
        y: Number.parseFloat(layer.style.getPropertyValue('--hdr-glass-y')),
        width: Number.parseFloat(layer.style.getPropertyValue('--hdr-glass-width')),
        height: Number.parseFloat(layer.style.getPropertyValue('--hdr-glass-height'))
    }));
    await page.mouse.move(to.x, to.y);
    await page.mouse.move(midpoint.x, midpoint.y);
    const rightToLeft = await page.locator('.liquid-glass-lens').evaluate((lens) => ({
        rect: lens.getBoundingClientRect().toJSON(),
        progress: Number(lens.dataset.liquidProgress),
        scaleX: new DOMMatrix(getComputedStyle(lens).transform).a,
        bridging: lens.classList.contains('is-bridging')
    }));
    expect(leftToRight.progress).toBeCloseTo(expectedProgress, 2);
    expect(rightToLeft.progress).toBeCloseTo(1 - expectedProgress, 2);
    expect(leftToRight.bridging).toBe(true);
    expect(rightToLeft.bridging).toBe(true);
    expect(leftToRight.rect.x).toBeCloseTo(rightToLeft.rect.x, 0);
    expect(leftToRight.rect.width).toBeCloseTo(rightToLeft.rect.width, 0);
    expect(leftToRight.rect.width).toBeGreaterThan(Math.max(from.box.width, to.box.width) + 16);
    expect(hdrGeometry.x).toBeCloseTo(leftToRight.rect.x, 0);
    expect(hdrGeometry.y).toBeCloseTo(leftToRight.rect.y, 0);
    expect(hdrGeometry.width).toBeCloseTo(leftToRight.rect.width, 0);
    expect(hdrGeometry.height).toBeCloseTo(leftToRight.rect.height, 0);
    expect(leftToRight.scaleX).toBeGreaterThan(0);
    expect(rightToLeft.scaleX).toBeGreaterThan(0);
    expect(await page.locator('.liquid-glass-lens').textContent()).toBe('');
    expect(errors).toEqual([]);
});

test('does not jump the glass lens to another row when the last row has no neighbour', async ({ page }) => {
    const seed = structuredClone(initialData);
    let errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const columns = await page.locator('.launchpad-grid').evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    // The root grid holds the POM folder tile, the bookmarks and the add tile: fill one row plus one item.
    seed.bookmarks = [
        ...Array.from({ length: columns - 1 }, (_, index) => ({
            id: index + 1,
            name: `Site ${index + 1}`,
            url: `https://site-${index + 1}.example.com/`,
            icon: '',
            folder: '全部',
            order: index
        })),
        { id: 99, name: 'POM site', url: 'https://pom.example.com/', icon: '', folder: 'POM', order: 0 }
    ];
    await page.evaluate((bookmarks) => new Promise((resolve) => chrome.storage.sync.set({ bookmarks }, resolve)), seed.bookmarks);
    await page.reload();
    await openLaunchpad(page);
    await expect(page.locator('.bookmark-tile')).toHaveCount(columns - 1);
    errors = [];
    const items = page.locator('.launchpad-grid > [data-liquid-item]');
    const rows = await items.evaluateAll((elements) => {
        const groups = [];
        elements.forEach((element, index) => {
            const top = element.getBoundingClientRect().top;
            const row = groups.find(([rowTop]) => Math.abs(rowTop - top) < 10);
            if (row) row[1].push(index);
            else groups.push([top, [index]]);
        });
        return groups.sort((left, right) => left[0] - right[0]);
    });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.at(-1)[1]).toHaveLength(1);

    const source = items.nth(rows.at(-1)[1][0]);
    const box = await source.boundingBox();
    expect(box).not.toBeNull();
    await source.hover();
    await expect(page.locator('.liquid-glass-lens')).toHaveClass(/is-visible/);
    await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2);
    await page.waitForTimeout(35);
    const transient = await page.locator('.liquid-glass-lens').evaluate((lens) => ({
        visible: lens.classList.contains('is-visible'),
        top: lens.getBoundingClientRect().top
    }));
    if (transient.visible) expect(Math.abs(transient.top - (box.y - 8))).toBeLessThan(24);
    await expect(page.locator('.liquid-glass-lens')).not.toHaveClass(/is-visible/, { timeout: 500 });
    expect(errors).toEqual([]);
});

test('moves and reorders bookmarks without duplication', async ({ page }) => {
    const errors = await openExtension(page);
    await openLaunchpad(page);
    await page.locator('.bookmark-tile[data-bookmark-id="1"]').dragTo(page.locator('.launchpad-tab[data-folder="POM"]'));
    await expect(page.locator('.bookmark-tile')).toHaveCount(1);
    let stored = await page.evaluate(() => window.__readMockSync());
    expect(stored.bookmarks).toHaveLength(3);
    expect(stored.bookmarks.find((bookmark) => String(bookmark.id) === '1').folder).toBe('POM');

    await page.locator('.folder-tile[data-folder="POM"]').click();
    await expect(page.locator('.launchpad-tab[data-folder="POM"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await page.locator('.bookmark-tile[data-bookmark-id="3"]').dragTo(page.locator('.bookmark-tile[data-bookmark-id="1"]'));
    stored = await page.evaluate(() => window.__readMockSync());
    expect(stored.bookmarks).toHaveLength(3);
    const pomOrder = stored.bookmarks.filter((bookmark) => bookmark.folder === 'POM').sort((a, b) => a.order - b.order).map((bookmark) => String(bookmark.id));
    expect(pomOrder).toEqual(['3', '1']);
    expect(new Set(stored.bookmarks.map((bookmark) => String(bookmark.id))).size).toBe(3);
    expect(errors).toEqual([]);
});

test('persists layout, theme and local wallpaper controls', async ({ page }) => {
    const errors = await openExtension(page);
    await openSettings(page, 'widgets');
    const settingsLayout = await page.locator('.settings-window').evaluate((window) => {
        const sidebar = window.querySelector('.settings-sidebar').getBoundingClientRect();
        const content = window.querySelector('.settings-content').getBoundingClientRect();
        return {
            width: window.getBoundingClientRect().width,
            sidebarBeside: sidebar.right <= content.left + 1,
            overflowFree: window.scrollWidth <= window.clientWidth
        };
    });
    expect(settingsLayout.width).toBe(920);
    expect(settingsLayout.sidebarBeside).toBe(true);
    expect(settingsLayout.overflowFree).toBe(true);
    await page.locator('input[data-toggle="showStatus"]').uncheck();
    await expect(page.locator('status-strip')).toBeHidden();
    await page.locator('input[data-toggle="showBookmarks"]').uncheck();
    await expect(page.locator('.setting-row[data-depends="showBookmarks"]').first()).toHaveClass(/is-disabled/);
    await expect(page.locator('home-dock')).toBeHidden();
    await page.locator('input[data-toggle="showBookmarks"]').check();
    await expect(page.locator('home-dock')).toBeVisible();
    await page.locator('[data-segment="dockSource"] [data-value="recent"]').click();
    await expect(page.locator('.dock-item[data-site-index]')).toHaveCount(2);

    await page.locator('.settings-nav-item[data-pane="appearance"]').click();
    await page.locator('[data-segment="clockFormat"] [data-value="12h"]').click();
    await expect(page.locator('[data-segment="clockFormat"] [data-value="12h"]')).toHaveAttribute('aria-checked', 'true');
    const appearanceToggles = page.locator('.settings-pane[data-pane="appearance"] liquid-toggle');
    await expect(appearanceToggles).toHaveCount(2);
    await expect(page.locator('.settings-pane[data-pane="appearance"] .liquid-toggle-thumb[data-liquid-profile="lip"]')).toHaveCount(2);
    const toggleMapCount = await page.locator('liquid-toggle feImage[result="displacement_map"]').evaluateAll((images) => (
        new Set(images.map((image) => image.getAttribute('href'))).size
    ));
    expect(toggleMapCount).toBe(1);
    await appearanceToggles.first().evaluate((control) => { window.__retainedLiquidControl = control; });
    await appearanceToggles.first().hover();
    await expect(page.locator('.hdr-glass-layer')).toHaveAttribute('data-hdr-target', 'liquid-toggle');
    const controlHdrSize = await page.locator('.hdr-glass-layer').evaluate((canvas) => ({
        width: Number.parseFloat(canvas.style.getPropertyValue('--hdr-glass-width')),
        height: Number.parseFloat(canvas.style.getPropertyValue('--hdr-glass-height'))
    }));
    expect(controlHdrSize.width).toBeGreaterThan(20);
    expect(controlHdrSize.height).toBeGreaterThan(20);
    await expect(appearanceToggles.first().locator('feDisplacementMap')).toHaveAttribute('scale', String(55.65161904498752 * 0.4));
    const hdrToggle = page.locator('input[data-toggle="hdrHighlights"]');
    await hdrToggle.dispatchEvent('pointerdown');
    await expect(appearanceToggles.first()).toHaveClass(/is-active/);
    await expect(appearanceToggles.first().locator('feDisplacementMap')).toHaveAttribute('scale', String(55.65161904498752 * 0.9));
    await hdrToggle.dispatchEvent('pointerup');
    await expect(hdrToggle).toBeChecked();
    await hdrToggle.uncheck();
    await expect(page.locator('body')).not.toHaveClass(/hdr-highlights/);
    await hdrToggle.check();
    await expect(page.locator('body')).toHaveClass(/hdr-highlights/);
    await page.locator('input[data-toggle="reduceTransparency"]').check();
    await expect(page.locator('body')).toHaveClass(/reduce-transparency/);
    await page.locator('[data-segment="theme"] [data-value="dark"]').click();
    await expect(page.locator('body')).toHaveClass(/theme-dark/);
    await page.locator('.settings-close').click();
    await expect(page.locator('.settings-window')).not.toHaveClass(/is-open/);
    await page.locator('.settings-trigger').click();
    expect(await page.evaluate(() => (
        window.__retainedLiquidControl?.isConnected
        && window.__retainedLiquidControl === document.querySelector('.settings-pane[data-pane="appearance"] liquid-toggle')
    ))).toBe(true);

    await page.locator('.settings-nav-item[data-pane="wallpaper"]').click();
    const wallpaperRanges = page.locator('.settings-pane[data-pane="wallpaper"] liquid-range');
    await expect(wallpaperRanges).toHaveCount(2);
    // 每个滑块共用同一个凸面 profile，数量随设置项增减，这里只断言口径一致。
    const thumbProfiles = await page.locator('.liquid-range-thumb').evaluateAll((nodes) => (
        [...new Set(nodes.map((node) => node.dataset.liquidProfile))]
    ));
    expect(thumbProfiles).toEqual(['convex']);
    const rangeMapCount = await page.locator('liquid-range feImage[result="displacement_map"]').evaluateAll((images) => (
        new Set(images.map((image) => image.getAttribute('href'))).size
    ));
    expect(rangeMapCount).toBe(1);
    const overlayRange = page.locator('input[name="overlay"]');
    await overlayRange.fill('45');
    await expect(wallpaperRanges.nth(1)).toHaveCSS('--liquid-progress', '75%');
    await overlayRange.dispatchEvent('pointerdown');
    await expect(wallpaperRanges.nth(1)).toHaveClass(/is-active/);
    await expect(wallpaperRanges.nth(1).locator('feDisplacementMap')).toHaveAttribute('scale', String(83.88118841653394 * 0.9));
    await overlayRange.dispatchEvent('pointerup');
    await page.locator('.upload-wallpaper input').setInputFiles({
        name: 'wallpaper.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    });
    await expect.poll(() => page.evaluate(() => window.__readMockSync().settings.wallpaper.type)).toBe('local');
    await expect(page.locator('.wallpaper-name')).toHaveText('本地图片');
    await expect(page.locator('[data-segment="wallpaperKind"] [data-value="image"]')).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.locator('.wallpaper-media')).toHaveCSS('background-image', /blob:/);
    await expect(page.locator('.wallpaper-pause')).toBeHidden();
    const stored = await page.evaluate(() => window.__readMockSync().settings);
    expect(stored.layout.showStatus).toBe(false);
    expect(stored.layout.dockSource).toBe('recent');
    expect(stored.appearance.theme).toBe('dark');
    expect(stored.appearance.clockFormat).toBe('12h');
    expect(stored.appearance.hdrHighlights).toBe(true);
    expect(stored.appearance.reduceTransparency).toBe(true);
    expect(errors).toEqual([]);
});

test('filters settings across every pane', async ({ page }) => {
    const errors = await openExtension(page);
    await openSettings(page);
    await page.locator('.settings-search input').fill('暂停');
    await expect(page.locator('.settings-pane:visible')).toHaveCount(1);
    await expect(page.locator('.setting-row:visible')).toHaveCount(2);
    await page.locator('.settings-search input').fill('Dock');
    await expect(page.locator('.setting-row:visible').first()).toContainText('Dock');
    await page.locator('.settings-search input').fill('不存在的设置');
    await expect(page.locator('.settings-empty')).toBeVisible();
    await page.locator('.settings-nav-item[data-pane="data"]').click();
    await expect(page.locator('.settings-search input')).toHaveValue('');
    await expect(page.locator('.sync-summary')).toHaveText('3 个书签 · 1 个文件夹');
    expect(errors).toEqual([]);
});

test('keeps the previous wallpaper when IndexedDB storage fails', async ({ page }) => {
    const errors = await openExtension(page, initialData, { failIndexedDB: true });
    await openSettings(page, 'wallpaper');
    await page.locator('.upload-wallpaper input').setInputFiles({
        name: 'wallpaper.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    });
    await expect(page.locator('.toast.is-error')).toContainText('IndexedDB');
    const state = await page.evaluate(() => ({ sync: window.__readMockSync(), local: window.__readMockLocal() }));
    expect(state.sync.settings.wallpaper).toEqual(initialData.settings.wallpaper);
    expect(state.local).not.toHaveProperty('localImageWallpaper');
    expect(state.local).not.toHaveProperty('localVideoWallpaper');
    expect(errors).toEqual([]);
});

test('reports native video playback failures instead of swallowing them', async ({ page }) => {
    const videoBase64 = fs.readFileSync(require.resolve('../fixtures/wallpaper.webm')).toString('base64');
    await page.addInitScript(() => {
        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value() { return Promise.reject(new DOMException('模拟播放失败', 'NotSupportedError')); }
        });
    });
    const errors = await openExtension(page);
    await page.evaluate(async (encodedVideo) => {
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('infinity-wallpaper', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('wallpapers')) request.result.createObjectStore('wallpapers');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const bytes = Uint8Array.from(atob(encodedVideo), (character) => character.charCodeAt(0));
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('wallpapers', 'readwrite');
            transaction.objectStore('wallpapers').put(new Blob([bytes], { type: 'video/webm' }), 'video');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        const stored = window.__readMockSync();
        stored.settings.wallpaper = { ...stored.settings.wallpaper, type: 'video', value: 'local' };
        await new Promise((resolve) => chrome.storage.sync.set({ settings: stored.settings }, resolve));
    }, videoBase64);
    await page.reload();
    await expect(page.locator('.app-notice')).toBeVisible();
    await expect(page.locator('.app-notice')).toContainText('背景加载失败');
    await expect(page.locator('.app-notice')).toContainText('已保留原背景');
    await expect(page.locator('.wallpaper-media video')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('imports a version 1 backup and exports version 2', async ({ page }, testInfo) => {
    const errors = await openExtension(page);
    const backup = {
        version: '1.0',
        exportDate: '2026-01-24T14:12:46.859Z',
        data: {
            bookmarks: [{ id: 10, name: 'www.v2ex.com', url: 'https://www.v2ex.com/', order: 0 }],
            folders: ['全部'],
            settings: {
                layout: { showClock: true, showSearch: true, showBookmarks: true, dockSource: 'bookmarks' },
                wallpaper: { type: 'gradient', value: '', blur: 0, overlay: 30 },
                appearance: { clockFormat: '24h', dateFormat: 'long' }
            },
            todos: []
        }
    };
    await openSettings(page, 'data');
    await page.locator('.import-data input').setInputFiles({
        name: 'legacy-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
    });
    await expect(page.getByRole('alertdialog')).toContainText('从备份恢复');
    await page.getByRole('alertdialog').getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('.toast.is-success')).toContainText('已从备份恢复');
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(1);
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveAttribute('aria-label', 'v2ex.com');
    const stored = await page.evaluate(() => window.__readMockSync());
    expect(stored.bookmarks).toHaveLength(1);
    expect(stored.bookmarks[0].folder).toBe('全部');
    expect(stored.settings.layout.showStatus).toBe(true);
    expect(stored.settings.layout.dockSize).toBe(56);
    const raw = await page.evaluate(() => window.__readRawSync());
    expect(raw).not.toHaveProperty('bookmarks');
    expect(raw.bookmarkChunks).toBe(1);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('.export-data').click();
    const download = await downloadPromise;
    const path = testInfo.outputPath('backup.json');
    await download.saveAs(path);
    const exported = JSON.parse(fs.readFileSync(path, 'utf8'));
    expect(exported.version).toBe('2.0');
    expect(exported.data.bookmarks).toHaveLength(1);
    expect(exported.localMedia).toEqual({ image: null, video: null });
    expect(errors).toEqual([]);
});

test('saves a WebDAV account and uploads a backup to it', async ({ page }) => {
    const errors = await openExtension(page, initialData, { fetchMock: {} });
    await openSettings(page, 'data');

    // 没配置时远端动作不可用。
    await expect(page.locator('.webdav-save')).toBeEnabled();
    await expect(page.locator('.webdav-upload')).toBeDisabled();
    await expect(page.locator('.webdav-restore')).toBeDisabled();
    await expect(page.locator('.webdav-status')).toHaveText('未配置');

    await page.locator('.webdav-url').fill('https://dav.example.com:8080/remote.php/dav/files/me');
    await page.locator('.webdav-user').fill('backup-bot');
    await page.locator('.webdav-pass').fill('s3cret');
    await page.locator('.webdav-file').fill('backup.json');
    await page.locator('.webdav-save').click();
    // 没装后台 mock，所以网络权限申请不到 —— 保存成功但要提示跨域风险。
    await expect(page.locator('.toast.is-info').last()).toContainText('远端还没有备份文件');
    await expect(page.locator('.webdav-status')).toHaveText('https://dav.example.com:8080/remote.php/dav/files/me');
    await expect(page.locator('.webdav-upload')).toBeEnabled();

    // 账密只落在本机存储，不占同步空间。
    expect(await page.evaluate(() => window.__readMockLocal().webdav)).toEqual({
        url: 'https://dav.example.com:8080/remote.php/dav/files/me',
        username: 'backup-bot',
        password: 's3cret',
        file: 'backup.json'
    });
    expect(await page.evaluate(() => window.__readMockSync().webdav)).toBeUndefined();

    await page.locator('.webdav-upload').click();
    await expect(page.locator('.toast.is-success').last()).toContainText('已上传');
    const remote = await page.evaluate(() => window.__webdav);
    expect(remote.requests.map((request) => request.method)).toEqual(['PROPFIND', 'PUT', 'PROPFIND']);
    expect(remote.requests[1].url).toBe('https://dav.example.com:8080/remote.php/dav/files/me/backup.json');
    expect(remote.requests[1].headers.Authorization).toBe(`Basic ${Buffer.from('backup-bot:s3cret').toString('base64')}`);
    expect(remote.requests[1].headers['Content-Type']).toBe('application/json');
    expect(remote.file.name).toBe('backup.json');
    const uploaded = JSON.parse(remote.file.text);
    expect(uploaded.version).toBe('2.0');
    expect(uploaded.data.bookmarks).toHaveLength(3);
    expect(errors).toEqual([]);
});

test('restores a WebDAV backup and deletes the remote copy', async ({ page }) => {
    const remoteBackup = {
        version: '2.0',
        exportDate: '2026-01-24T14:12:46.859Z',
        data: {
            bookmarks: [{ id: 9, name: 'www.v2ex.com', url: 'https://www.v2ex.com/', icon: '', folder: '全部', order: 0 }],
            folders: ['全部'],
            settings: {
                layout: { showClock: true, showSearch: true, showBookmarks: true, showStatus: true, showRecent: true, searchEngine: 'google', dockSource: 'bookmarks' },
                wallpaper: { type: 'gradient', value: '', blur: 0, overlay: 30, idleHide: false },
                appearance: { clockFormat: '24h', dateFormat: 'long', enhancedAnimations: true, theme: 'light' }
            },
            recentSearches: [],
            lastBackupPrompt: 4102444800000
        },
        localMedia: { image: null, video: null }
    };
    const errors = await openExtension(page, initialData, { fetchMock: { file: JSON.stringify(remoteBackup) } });
    await openSettings(page, 'data');

    await page.locator('.webdav-url').fill('https://dav.example.com/dav');
    await page.locator('.webdav-user').fill('bot');
    await page.locator('.webdav-pass').fill('pw');
    await page.locator('.webdav-save').click();
    await expect(page.locator('.toast.is-info').last()).toContainText('远端已有');
    // 未授权时要在卡片上说明上传会遇到跨域问题。
    await expect(page.locator('.webdav-note')).toContainText('后台通道未启用');

    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(2);
    await page.locator('.webdav-restore').click();
    await expect(page.getByRole('alertdialog')).toContainText('从 WebDAV 恢复');
    await page.getByRole('alertdialog').getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('.toast.is-success').last()).toContainText('已从 WebDAV 恢复');
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(1);
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveAttribute('aria-label', 'v2ex.com');
    expect(await page.evaluate(() => window.__webdav.requests.filter((request) => request.method === 'GET'))).toHaveLength(1);

    await page.locator('.webdav-delete').click();
    await expect(page.getByRole('alertdialog')).toContainText('删除远端备份');
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.toast.is-success').last()).toContainText('已删除远端备份');
    expect(await page.evaluate(() => window.__webdav.file)).toBeNull();
    // 删除远端不影响本机。
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(1);
    expect(errors).toEqual([]);
});

test('uploads through the background worker once the host permission is granted', async ({ page }) => {
    const errors = await openExtension(page, initialData, { fetchMock: {}, backgroundMock: {} });
    await openSettings(page, 'data');

    await page.locator('.webdav-url').fill('https://infini-cloud.example.com/dav/');
    await page.locator('.webdav-user').fill('bot');
    await page.locator('.webdav-pass').fill('pw');
    await page.locator('.webdav-save').click();
    // 授权成功后要提示请求已经改走后台通道。
    await expect(page.locator('.toast.is-success').last()).toContainText('不受跨域限制');
    await expect(page.locator('.webdav-note')).toContainText('请求走后台通道');

    await page.locator('.webdav-upload').click();
    await expect(page.locator('.toast.is-success').last()).toContainText('已上传');

    const webdav = await page.evaluate(() => window.__webdav);
    // chrome.permissions 要的是 match pattern，必须带 /* 路径。
    expect(webdav.permissionRequests).toEqual([['https://infini-cloud.example.com/*']]);
    expect(webdav.requests.map((request) => request.method)).toEqual(['PROPFIND', 'PUT', 'PROPFIND']);
    // 授权后没有任何一次请求再走页面直连 —— 页面根本过不了跨域检查。
    expect(webdav.requests.every((request) => request.via === 'background')).toBe(true);
    expect(webdav.requests[1].headers.Authorization).toBe(`Basic ${Buffer.from('bot:pw').toString('base64')}`);
    expect(webdav.requests[1].headers['Content-Type']).toBe('application/json');
    expect(webdav.file.name).toBe('infinity-newtab-backup.json');
    const uploaded = JSON.parse(webdav.file.text);
    expect(uploaded.version).toBe('2.0');
    expect(uploaded.data.bookmarks).toHaveLength(3);
    expect(errors).toEqual([]);
});

test('keeps the backup reminder clear of the Dock and lets it be dismissed', async ({ page }) => {
    const errors = await openExtension(page, { ...initialData, lastBackupPrompt: 0 });
    for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 1000 });
        const toast = await page.locator('.backup-toast').boundingBox();
        const dock = await page.locator('.dock').boundingBox();
        expect(toast).not.toBeNull();
        expect(dock).not.toBeNull();
        expect(overlaps(toast, dock)).toBe(false);
    }
    await page.locator('.backup-later').click();
    await expect(page.locator('backup-toast')).toBeHidden();
    expect(Date.now() - (await page.evaluate(() => window.__readMockSync().lastBackupPrompt))).toBeLessThan(60000);
    expect(errors).toEqual([]);
});

test('closes overlays with Escape and returns focus to the opener', async ({ page }) => {
    const errors = await openExtension(page);
    await page.locator('.dock-all').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.launchpad')).toBeVisible();
    const add = page.locator('.add-bookmark');
    await add.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '添加书签' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="url"]')).toBeFocused();
    // Focus stays trapped inside the dialog.
    for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('bookmark-launchpad')).toBeHidden();
    await expect(page.locator('.dock-all')).toBeFocused();

    await page.locator('.settings-trigger').click();
    await expect(page.locator('.settings-window')).toHaveClass(/is-open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-window')).not.toHaveClass(/is-open/);
    await expect(page.locator('.settings-trigger')).toBeFocused();
    expect(errors).toEqual([]);
});

test('manages bookmarks and folders through the context menu and in-page dialogs', async ({ page }) => {
    const errors = await openExtension(page);
    page.on('dialog', () => { throw new Error('native browser dialogs must not be used'); });
    await openLaunchpad(page);

    await page.locator('.bookmark-tile[data-bookmark-id="2"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'POM' }).click();
    await expect(page.locator('.bookmark-tile')).toHaveCount(1);
    expect((await page.evaluate(() => window.__readMockSync())).bookmarks.find((bookmark) => String(bookmark.id) === '2').folder).toBe('POM');

    await page.locator('.launchpad-tab.create-folder').click();
    const prompt = page.getByRole('alertdialog');
    await prompt.locator('input').fill('阅读');
    await prompt.getByRole('button', { name: '创建' }).click();
    await expect(page.locator('.launchpad-tab[data-folder="阅读"]')).toHaveCount(1);
    await expect(page.locator('.folder-tile[data-folder="阅读"]')).toHaveCount(1);

    await page.locator('.launchpad-tab[data-folder="POM"]').click();
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await page.locator('.launchpad-tab[data-folder="POM"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名…' }).click();
    await page.getByRole('alertdialog').locator('input').fill('收藏');
    await page.getByRole('alertdialog').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.launchpad-tab[data-folder="收藏"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);

    await page.locator('.bookmark-tile[data-bookmark-id="3"] .tile-more').click({ force: true });
    await page.getByRole('menuitem', { name: '删除书签' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.bookmark-tile')).toHaveCount(1);

    await page.locator('.launchpad-search input').fill('git');
    await expect(page.locator('.launchpad-grid')).toHaveAttribute('data-view', 'search');
    await expect(page.locator('.bookmark-tile')).toHaveCount(1);
    await expect(page.locator('.launchpad-search input')).toBeFocused();
    expect(errors).toEqual([]);
});

test('Spotlight searches bookmarks, history and recent searches', async ({ page }) => {
    const errors = await openExtension(page, { ...initialData, recentSearches: ['二次元壁纸', 'typescript'] });
    await page.keyboard.press('/');
    const input = page.locator('.spotlight-field input');
    await expect(input).toBeFocused();
    await expect(page.locator('body')).toHaveClass(/spotlight-open/);
    await expect(page.locator('.spotlight-row', { hasText: '二次元壁纸' })).toHaveCount(1);

    await input.fill('git');
    const first = page.locator('.spotlight-row').first();
    await expect(first).toContainText('GitHub');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ghost-rest')).toHaveText('hub.com');
    await expect(page.locator('.spotlight-scope')).toHaveText('书签');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.spotlight-row').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.spotlight-row').nth(1)).toContainText('在 Google 中搜索');
    await page.keyboard.press('Tab');
    await expect(page.locator('.spotlight-engines [data-engine="bing"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.spotlight-row').nth(1)).toContainText('在 Bing 中搜索');
    await expect(input).toBeFocused();

    await input.fill('youtube.com');
    await expect(page.locator('.spotlight-row').first()).toContainText('youtube.com');
    await expect(page.locator('.spotlight-heading').first()).toHaveText('网址');

    await input.fill('');
    const recent = page.locator('.spotlight-row', { hasText: '二次元壁纸' });
    await recent.hover();
    await recent.locator('.row-remove').click();
    await expect(page.locator('.spotlight-row', { hasText: '二次元壁纸' })).toHaveCount(0);
    expect((await page.evaluate(() => window.__readMockSync())).recentSearches).toEqual(['typescript']);
    expect((await page.evaluate(() => window.__readMockSync())).settings.layout.searchEngine).toBe('google');

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await expect(page.locator('spotlight-search')).toBeHidden();
    await page.locator('.search-pill').click();
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('spotlight-search')).toBeHidden();
    expect(errors).toEqual([]);
});

test('fades to the clock alone when idle', async ({ page }) => {
    const seed = structuredClone(initialData);
    seed.settings.wallpaper.idleHide = true;
    // A fake clock keeps stray input on the headed window from restarting a real 8-second wait.
    await page.clock.install();
    const errors = await openExtension(page, seed);
    await page.mouse.move(10, 10);
    await page.clock.runFor(8500);
    await expect(page.locator('body')).toHaveClass(/is-idle/);
    await expect(page.locator('home-dock')).toHaveCSS('opacity', '0');
    await expect(page.locator('dashboard-header')).toHaveCSS('opacity', '0.85');
    await page.mouse.move(200, 200);
    await expect(page.locator('body')).not.toHaveClass(/is-idle/);
    expect(errors).toEqual([]);
});

test('shows frequent sites in the Dock by default', async ({ page }) => {
    const seed = structuredClone(initialData);
    delete seed.settings.layout.dockSource;
    const errors = await openExtension(page, seed);
    await expect(page.locator('.dock-item[data-site-index]')).toHaveCount(2);
    await expect(page.locator('.dock-item[data-bookmark-id]')).toHaveCount(0);
    await expect(page.locator('.dock-slot')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('caps the Dock and the launchpad at 20 frequent sites', async ({ page }) => {
    const seed = structuredClone(initialData);
    delete seed.settings.layout.dockSource;
    // 26 个站点，足够越过上限，才能验证确实被截断。
    const history = Array.from({ length: 26 }, (_, index) => ({
        url: `https://site-${index}.example.com/`,
        visitCount: 26 - index,
        lastVisitTime: 300 - index
    }));
    const errors = await openExtension(page, seed, { history });
    await expect(page.locator('.dock-item[data-site-index]')).toHaveCount(20);
    await expect(page.locator('.dock-slot')).toHaveCount(0);

    await openLaunchpad(page, 'recent');
    await expect(page.locator('.recent-tile')).toHaveCount(20);
    expect(errors).toEqual([]);
});

test('keeps history out of every view when frequent sites are turned off', async ({ page }) => {
    const seed = structuredClone(initialData);
    seed.settings.layout = { ...seed.settings.layout, showRecent: false, dockSource: 'recent' };
    const errors = await openExtension(page, seed);
    await expect(page.locator('.dock-recent, .dock-item[data-site-index]')).toHaveCount(0);
    await openLaunchpad(page);
    await expect(page.locator('.launchpad-tab[data-view="recent"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await expect(page.locator('.spotlight-field input')).toBeFocused();
    await page.locator('.spotlight-field input').fill('youtube');
    await expect(page.locator('.spotlight-heading', { hasText: '常访问' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await openSettings(page, 'widgets');
    await expect(page.locator('[data-segment="dockSource"]').locator('xpath=ancestor::*[contains(@class,"setting-row")]')).toHaveClass(/is-disabled/);
    await page.locator('input[data-toggle="showRecent"]').check();
    await expect(page.locator('.dock-item[data-site-index]')).toHaveCount(2);
    await expect(page.locator('.dock-recent')).toHaveCount(1);
    expect((await page.evaluate(() => window.__readMockSync())).settings.layout.showRecent).toBe(true);
    expect(errors).toEqual([]);
});

test('removes a frequent site from 常访问 and restores it in settings', async ({ page }) => {
    const errors = await openExtension(page);
    await openLaunchpad(page, 'recent');
    await expect(page.locator('.recent-tile')).toHaveCount(2);
    const historyBefore = await page.evaluate(() => new Promise((resolve) => chrome.history.search({}, resolve)));

    await page.locator('.recent-tile').first().click({ button: 'right' });
    await expect(page.locator('.context-menu button', { hasText: '从常访问移除' })).toBeVisible();
    await page.locator('.context-menu button', { hasText: '从常访问移除' }).click();

    // 整站消失，浏览器历史原样保留。
    await expect(page.locator('.recent-tile')).toHaveCount(1);
    await expect(page.locator('.launchpad-grid')).not.toContainText('youtube.com');
    expect((await page.evaluate(() => window.__readMockSync())).settings.layout.recentExcluded).toEqual(['youtube.com']);
    expect(await page.evaluate(() => new Promise((resolve) => chrome.history.search({}, resolve)))).toEqual(historyBefore);

    // 把剩下的站点也移除，回到空状态提示。
    await page.locator('.recent-tile').first().click({ button: 'right' });
    await page.locator('.context-menu button', { hasText: '从常访问移除' }).click();
    await expect(page.locator('.recent-tile')).toHaveCount(0);
    await expect(page.locator('.launchpad-message')).toHaveText('最近 30 天还没有可展示的网站');
    expect((await page.evaluate(() => window.__readMockSync())).settings.layout.recentExcluded).toEqual(['youtube.com', 'v2ex.com']);

    await page.locator('.launchpad-done').click();
    await openSettings(page, 'widgets');
    await expect(page.locator('.restore-recent')).toBeEnabled();
    await page.locator('.restore-recent').click();
    await expect(page.locator('.restore-recent')).toBeDisabled();
    await expect(page.locator('.settings-pane[data-pane="widgets"]').locator('.row-sub', { hasText: '共 0 个' })).toBeVisible();
    expect((await page.evaluate(() => window.__readMockSync())).settings.layout.recentExcluded).toEqual([]);
    await page.keyboard.press('Escape');
    await openLaunchpad(page, 'recent');
    await expect(page.locator('.recent-tile')).toHaveCount(2);
    await expect(page.locator('.launchpad-grid')).toContainText('youtube.com');
    expect(errors).toEqual([]);
});

test('edits a bookmark in place instead of duplicating it', async ({ page }) => {
    const errors = await openExtension(page);
    await openLaunchpad(page);
    await page.locator('.launchpad .bookmark-tile[data-bookmark-id]').first().click({ button: 'right' });
    await page.getByText('编辑…', { exact: true }).click();
    const dialog = page.locator('.bookmark-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="name"]')).toHaveValue('www.google.com');
    await dialog.locator('input[name="name"]').fill('Google 搜索');
    await dialog.locator('input[name="icon"]').fill('https://example.com/google.png');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    const saved = await page.evaluate(() => window.__readMockSync().bookmarks);
    expect(saved).toHaveLength(3);
    expect(saved[0]).toMatchObject({ name: 'Google 搜索', icon: 'https://example.com/google.png' });
    await expect(page.locator('.launchpad .bookmark-tile[data-bookmark-id]').first()).toContainText('Google 搜索');
    expect(errors).toEqual([]);
});

test('compresses a local image into an inline icon that fits sync storage', async ({ page }) => {
    const errors = await openExtension(page);
    await openLaunchpad(page);
    await page.locator('.launchpad .bookmark-tile[data-bookmark-id]').first().click({ button: 'right' });
    await page.getByText('编辑…', { exact: true }).click();
    const dialog = page.locator('.bookmark-dialog');
    await expect(dialog).toBeVisible();

    // 512×512 的渐变加噪点，体积接近真实 logo，压缩逻辑必须真的动手。
    const bytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const context = canvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, 512, 512);
        gradient.addColorStop(0, '#ff5f57');
        gradient.addColorStop(0.5, '#b9a2ff');
        gradient.addColorStop(1, '#0a84ff');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 512, 512);
        for (let index = 0; index < 900; index += 1) {
            context.fillStyle = `hsla(${index % 360}, 90%, 60%, 0.6)`;
            context.beginPath();
            context.arc((index * 37) % 512, (index * 71) % 512, 6, 0, Math.PI * 2);
            context.fill();
        }
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    await dialog.locator('.icon-upload input[type="file"]').setInputFiles({
        name: 'logo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(bytes)
    });
    await expect(dialog.locator('.icon-status')).toContainText('已使用本地图片');
    await expect(dialog.locator('input[name="icon"]')).toHaveValue('');
    expect(await dialog.locator('.url-preview').getAttribute('src')).toMatch(/^data:image\/webp;base64,/);

    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    const saved = await page.evaluate(() => window.__readMockSync().bookmarks);
    const icon = saved.find((bookmark) => bookmark.name === 'www.google.com').icon;
    expect(icon).toMatch(/^data:image\/webp;base64,/);
    // 内嵌图标必须落在 chrome.storage.sync 的单条预算内，否则刷新后会悄悄消失。
    expect(icon.length).toBeLessThanOrEqual(4096);

    // 再次编辑时，内嵌图标应还原成「本地图片」状态，而不是塞进网址输入框。
    await page.locator('.launchpad .bookmark-tile[data-bookmark-id]').first().click({ button: 'right' });
    await page.getByText('编辑…', { exact: true }).click();
    await expect(dialog.locator('.icon-status')).toContainText('已使用本地图片');
    await expect(dialog.locator('input[name="icon"]')).toHaveValue('');
    await dialog.locator('.cancel-dialog').click();
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('clears icons that unrelated sites share by mistake', async ({ page }) => {
    const shared = 'https://infinityicon.infinitynewtab.com/user-share-icon/cee009549b352def723ba09d6da4b742.png';
    const seed = structuredClone(initialData);
    seed.bookmarks[0].icon = shared;
    seed.bookmarks[1].icon = shared;
    // 同一站点的两条书签共用图标是正常的，不能被清掉。
    seed.bookmarks[2].icon = 'https://www.bilibili.com/favicon.ico';
    seed.bookmarks.push({ id: 4, name: 'Bilibili 番剧', url: 'https://www.bilibili.com/anime/', icon: 'https://www.bilibili.com/favicon.ico', folder: 'POM', order: 1 });

    const errors = await openExtension(page, seed);

    // 串号图标在加载时就已经修掉，不依赖用户记得点按钮。
    const afterLoad = await page.evaluate(() => window.__readMockSync().bookmarks);
    expect(afterLoad.find((bookmark) => bookmark.name === 'www.google.com').icon).toBe('');
    expect(afterLoad.find((bookmark) => bookmark.name === 'GitHub').icon).toBe('');
    expect(afterLoad.find((bookmark) => bookmark.name === 'Bilibili').icon).toBe('https://www.bilibili.com/favicon.ico');
    expect(afterLoad.find((bookmark) => bookmark.name === 'Bilibili 番剧').icon).toBe('https://www.bilibili.com/favicon.ico');

    await openSettings(page, 'data');
    await page.locator('.fix-icons').click();
    await expect(page.locator('.toast')).toContainText('没有发现被多个站点共用的图标');

    // 画面上也不能再出现串号地址。
    await page.keyboard.press('Escape');
    await openLaunchpad(page);
    const rendered = await page.locator('.launchpad .bookmark-tile img').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') || ''));
    expect(rendered.some((src) => src.includes('cee009549b352'))).toBe(false);
    expect(errors).toEqual([]);
});

test('reorders folder tabs from the tab menu', async ({ page }) => {
    const seed = structuredClone(initialData);
    seed.folders = ['全部', 'POM', '工作'];
    seed.bookmarks.push({ id: 4, name: 'Figma', url: 'https://www.figma.com/', icon: '', folder: '工作', order: 0 });

    const errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const tabs = page.locator('.launchpad-tabs .launchpad-tab[data-folder]');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(1)).toHaveText('POM');
    await expect(tabs.nth(2)).toHaveText('工作');

    await tabs.nth(1).click({ button: 'right' });
    await page.getByText('右移', { exact: true }).click();
    await expect(tabs.nth(1)).toHaveText('工作');
    await expect(tabs.nth(2)).toHaveText('POM');
    expect((await page.evaluate(() => window.__readMockSync())).folders).toEqual(['全部', '工作', 'POM']);

    // 最左边的文件夹不能再左移，「全部」不参与排序。
    await tabs.nth(1).click({ button: 'right' });
    await expect(page.locator('.context-menu button', { hasText: '左移' })).toBeDisabled();
    await page.keyboard.press('Escape');
    // 「全部」是最外层文件夹，不可删除也不可排序；菜单只给「打开」，而不是右键后一片空白。
    await tabs.nth(0).click({ button: 'right' });
    await expect(page.locator('.context-menu button', { hasText: '打开' })).toHaveCount(1);
    await expect(page.locator('.context-menu button', { hasText: '删除文件夹' })).toHaveCount(0);
    await expect(page.locator('.context-menu button', { hasText: '重命名…' })).toHaveCount(0);
    await expect(page.locator('.context-menu button', { hasText: '左移' })).toHaveCount(0);
    await expect(page.locator('.context-menu button', { hasText: '右移' })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('reorders folder tabs by dragging one onto another', async ({ page }) => {
    const seed = structuredClone(initialData);
    seed.folders = ['全部', 'POM', '工作', '阅读'];
    for (const [index, folder] of ['工作', '阅读'].entries()) {
        seed.bookmarks.push({ id: 10 + index, name: folder, url: `https://${index}.example.com/`, icon: '', folder, order: 0 });
    }

    const errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const tabs = page.locator('.launchpad-tabs .launchpad-tab[data-folder]');
    await expect(tabs).toHaveCount(4);

    // 把「POM」拖到「阅读」的右半边 → 应该排到最后。
    await page.evaluate(() => {
        const items = [...document.querySelectorAll('.launchpad-tabs .launchpad-tab[data-folder]')];
        const drag = { source: items[1], target: items[3], transfer: new DataTransfer() };
        window.__drag = drag;
        drag.source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: drag.transfer }));
        const rect = drag.target.getBoundingClientRect();
        drag.target.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, dataTransfer: drag.transfer, clientX: rect.right - 2, clientY: rect.top + rect.height / 2
        }));
    });
    await expect(tabs.nth(3)).toHaveClass(/drop-after/);
    await page.evaluate(() => {
        const { source, target, transfer } = window.__drag;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent('drop', {
            bubbles: true, dataTransfer: transfer, clientX: rect.right - 2, clientY: rect.top + rect.height / 2
        }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
        delete window.__drag;
    });

    await expect(tabs.nth(1)).toHaveText('工作');
    await expect(tabs.nth(3)).toHaveText('POM');
    expect((await page.evaluate(() => window.__readMockSync())).folders).toEqual(['全部', '工作', '阅读', 'POM']);

    // 拖到左半边则插到该标签之前。
    await page.evaluate(() => {
        const items = [...document.querySelectorAll('.launchpad-tabs .launchpad-tab[data-folder]')];
        const drag = { source: items[3], target: items[1], transfer: new DataTransfer() };
        window.__drag = drag;
        drag.source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: drag.transfer }));
        const rect = drag.target.getBoundingClientRect();
        const point = { bubbles: true, dataTransfer: drag.transfer, clientX: rect.left + 2, clientY: rect.top + rect.height / 2 };
        drag.target.dispatchEvent(new DragEvent('dragover', point));
        drag.target.dispatchEvent(new DragEvent('drop', point));
        drag.source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag.transfer }));
        delete window.__drag;
    });

    await expect(tabs.nth(1)).toHaveText('POM');
    await expect(tabs.nth(3)).toHaveText('阅读');
    expect((await page.evaluate(() => window.__readMockSync())).folders).toEqual(['全部', 'POM', '工作', '阅读']);
    expect(errors).toEqual([]);
});

test('scrolls the folder tab strip with a plain mouse wheel', async ({ page }) => {
    const seed = structuredClone(initialData);
    // 文件夹多到把标签条撑出可视宽度，两侧的标签才有「滑过去」的需求。
    seed.folders = ['全部', ...Array.from({ length: 24 }, (_, index) => `资料${index + 1}`)];

    const errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const strip = page.locator('.launchpad-tabs');
    const track = page.locator('.launchpad-tab-track');
    await expect(track.locator('.launchpad-tab[data-folder]').first()).toBeVisible();
    // 「全部」+ 24 个文件夹，外加书签里自带的 POM，足够撑出横向溢出。
    expect(await track.locator('.launchpad-tab[data-folder]').count()).toBeGreaterThanOrEqual(25);

    expect(await track.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeGreaterThan(0);
    // 停在最左边时只有右侧还有内容，渐隐提示也应该只在右侧。
    await expect(track).toHaveClass(/has-more-right/);
    await expect(track).not.toHaveClass(/has-more-left/);

    const box = await strip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await expect(track).toHaveClass(/has-more-left/);

    // 竖直滚轮往回转同样有效，一直滚回最左边。
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBe(0);

    // 触控板的横向手势（deltaX）也走同一条路径。
    await page.mouse.wheel(180, 0);
    await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);

    // 滑到最右再点最后一个标签：重建标签后选中的那个必须自动滑回可视范围。
    await page.mouse.wheel(0, 4000);
    const last = track.locator('.launchpad-tab[data-folder]').last();
    await last.click();
    await expect(last).toHaveClass(/is-active/);
    expect(await last.evaluate((node) => {
        const tab = node.getBoundingClientRect();
        const view = node.parentElement.getBoundingClientRect();
        return tab.left >= view.left - 1 && tab.right <= view.right + 1;
    })).toBe(true);
    expect(errors).toEqual([]);
});

test('defines the launchpad columns, rows and icon size', async ({ page }) => {
    const seed = structuredClone(initialData);
    // 40 条书签，够铺好几屏，行数限制才有意义。
    for (let index = 0; index < 40; index += 1) {
        seed.bookmarks.push({ id: 100 + index, name: `站点 ${index}`, url: `https://site-${index}.example.com/`, icon: '', folder: '全部', order: 10 + index });
    }

    const errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const grid = page.locator('.launchpad-grid');
    // 默认是自动：列数由窗口决定，行高交给内容。
    await expect(grid).not.toHaveClass(/is-fixed/);
    expect(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBeGreaterThan(6);
    await page.locator('.launchpad-done').click();

    await openSettings(page, 'widgets');
    await page.locator('input[name="launchpadColumns"]').fill('6');
    await page.locator('input[name="launchpadRows"]').fill('4');
    await page.locator('input[name="launchpadTile"]').fill('120');
    await expect.poll(() => page.evaluate(() => window.__readMockSync().settings.layout)).toMatchObject({
        launchpadColumns: 6,
        launchpadRows: 4,
        launchpadTile: 120
    });
    await page.keyboard.press('Escape');

    await openLaunchpad(page);
    await expect(grid).toHaveClass(/is-fixed/);
    await expect(grid).toHaveClass(/has-row-count/);
    const fixed = await grid.evaluate((node) => {
        const style = getComputedStyle(node);
        const tiles = [...node.querySelectorAll('.tile')];
        return {
            columns: style.gridTemplateColumns.split(' ').length,
            rowHeight: parseFloat(style.gridAutoRows),
            tile: getComputedStyle(node.querySelector('.tile')).width,
            icon: parseFloat(getComputedStyle(node.querySelector('.tile .app-icon')).fontSize),
            // 只看首屏那 4 行（6 列 × 4 行）的底边：负值代表都还在可视区内。
            overflowBottom: Math.max(...tiles.slice(0, 24).map((tile) => tile.getBoundingClientRect().bottom)) - node.getBoundingClientRect().bottom
        };
    });
    expect(fixed.columns).toBe(6);
    expect(fixed.tile).toBe('120px');
    // 行高被压到 4 行均分的高度时，图标跟着行高缩（留出内边距和名称），不会顶出可视区。
    expect(fixed.rowHeight).toBeGreaterThan(100);
    expect(fixed.icon).toBeLessThanOrEqual(fixed.rowHeight - 39);
    expect(fixed.overflowBottom).toBeLessThanOrEqual(1);

    // 一屏正好 4 行：第 5 行的顶部必须落在可视区之外。
    const rows = await grid.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const tops = new Set();
        node.querySelectorAll('.tile').forEach((tile) => tops.add(Math.round(tile.getBoundingClientRect().top)));
        return [...tops].filter((top) => top < box.bottom - 4).length;
    });
    expect(rows).toBe(4);
    expect(errors).toEqual([]);
});

test('scrolls the launchpad grid from the empty side margins', async ({ page }) => {
    const seed = structuredClone(initialData);
    // 三屏书签，栅格才会真的溢出。
    for (let index = 0; index < 60; index += 1) {
        seed.bookmarks.push({ id: 100 + index, name: `站点 ${index}`, url: `https://site-${index}.example.com/`, icon: '', folder: '全部', order: 10 + index });
    }

    const errors = await openExtension(page, seed);
    await openLaunchpad(page);
    const grid = page.locator('.launchpad-grid');
    expect(await grid.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);

    // 栅格被限制在 1000px 居中，两侧留白不在滚动容器里，滚轮也得能滚。
    const box = await grid.boundingBox();
    const margin = box.x / 2;
    expect(margin).toBeGreaterThan(20);
    await page.mouse.move(margin, box.y + 120);
    await page.mouse.wheel(0, 320);
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

    // 反方向同样管用，一直滚回顶部。
    await page.mouse.wheel(0, -4000);
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBe(0);

    // 栅格内部交给浏览器自己滚，不能被接管后算成两倍距离。
    const tile = await page.locator('.launchpad .bookmark-tile').first().boundingBox();
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
});
