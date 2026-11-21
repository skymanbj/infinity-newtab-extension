"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/core/base64.ts
  function bytesToBase64(bytes) {
    const chunkSize = 32768;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  var init_base64 = __esm({
    "src/core/base64.ts"() {
      "use strict";
    }
  });

  // src/core/utils.ts
  function normalizeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    try {
      const url = new URL(candidate);
      return BOOKMARK_PROTOCOLS.has(url.protocol) && url.hostname ? url.href : "";
    } catch {
      return "";
    }
  }
  function sanitizeRemoteUrl(value, allowImageData = false) {
    if (typeof value !== "string") return "";
    if (allowImageData && value.startsWith("data:image/")) return value;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }
  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }
  var BOOKMARK_PROTOCOLS;
  var init_utils = __esm({
    "src/core/utils.ts"() {
      "use strict";
      BOOKMARK_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "chrome-extension:"]);
    }
  });

  // src/core/backup.ts
  function sanitizeImportedData(value) {
    if (!isRecord(value)) throw new Error("Backup data must be an object");
    const sanitized = {};
    const bookmarks = sanitizeBookmarks(Array.isArray(value.bookmarks) ? value.bookmarks : []);
    sanitized.bookmarks = bookmarks;
    const folders = /* @__PURE__ */ new Set();
    if (Array.isArray(value.folders)) {
      value.folders.forEach((folder) => {
        const name = cleanText(folder, 80);
        if (name) folders.add(name);
      });
    }
    folders.add("\u5168\u90E8");
    bookmarks.forEach((bookmark) => folders.add(bookmark.folder));
    sanitized.folders = Array.from(folders);
    if (value.settings !== void 0) sanitized.settings = sanitizeSettings(value.settings);
    if (Array.isArray(value.todos)) sanitized.todos = value.todos;
    if (Array.isArray(value.recentSearches)) {
      sanitized.recentSearches = value.recentSearches.map((entry) => cleanText(entry, 200)).filter(Boolean).slice(0, 20);
    }
    const backupTime = Number(value.lastBackupPrompt);
    if (Number.isFinite(backupTime)) sanitized.lastBackupPrompt = backupTime;
    return sanitized;
  }
  function sanitizeBookmarks(values) {
    const merged = /* @__PURE__ */ new Map();
    const seenIds = /* @__PURE__ */ new Set();
    values.forEach((raw, index) => {
      if (!isRecord(raw)) return;
      const url = normalizeUrl(raw.url);
      if (!url) return;
      const folder = cleanText(raw.folder, 80) || "\u5168\u90E8";
      const key = `${folder}|${canonicalUrl(url)}`;
      if (merged.has(key)) return;
      const rawId = typeof raw.id === "number" || typeof raw.id === "string" ? raw.id : Date.now() + index;
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
    const folders = /* @__PURE__ */ new Map();
    merged.forEach((bookmark) => {
      const list = folders.get(bookmark.folder) ?? [];
      list.push(bookmark);
      folders.set(bookmark.folder, list);
    });
    folders.forEach((list) => {
      list.sort((left, right) => left.order - right.order || String(left.id).localeCompare(String(right.id)));
      list.forEach((bookmark, index) => {
        bookmark.order = index;
      });
    });
    return Array.from(merged.values());
  }
  function hasDuplicateBookmarkIds(values) {
    const seen = /* @__PURE__ */ new Set();
    for (const row of values) {
      if (!isRecord(row)) continue;
      const id = typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : "";
      if (!id) continue;
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  }
  function sanitizeSettings(value) {
    const source = isRecord(value) ? value : {};
    const layout = isRecord(source.layout) ? source.layout : {};
    const wallpaper = isRecord(source.wallpaper) ? source.wallpaper : {};
    const appearance = isRecord(source.appearance) ? source.appearance : {};
    const searchEngines = ["google", "bing", "baidu", "duckduckgo"];
    const wallpaperTypes = ["gradient", "preset", "local", "video"];
    return {
      layout: {
        showClock: booleanOr(layout.showClock, true),
        showSearch: booleanOr(layout.showSearch, true),
        showBookmarks: booleanOr(layout.showBookmarks, true),
        showStatus: booleanOr(layout.showStatus, true),
        showRecent: booleanOr(layout.showRecent, true),
        openInNewTab: booleanOr(layout.openInNewTab, false),
        searchEngine: searchEngines.includes(String(layout.searchEngine)) ? layout.searchEngine : "google",
        /** Missing values (including old backups) follow the new default; only an explicit choice is kept. */
        dockSource: layout.dockSource === "bookmarks" ? "bookmarks" : "recent",
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
        type: wallpaperTypes.includes(String(wallpaper.type)) ? wallpaper.type : "gradient",
        value: sanitizeWallpaperValue(wallpaper.value),
        blur: clampNumber(wallpaper.blur, 0, 40, 0),
        overlay: clampNumber(wallpaper.overlay, 0, 60, 12),
        framing: sanitizeFraming(wallpaper.framing),
        idleHide: booleanOr(wallpaper.idleHide, true),
        pauseOnBattery: booleanOr(wallpaper.pauseOnBattery, true),
        pauseWhenHidden: booleanOr(wallpaper.pauseWhenHidden, true),
        sound: booleanOr(wallpaper.sound, false)
      },
      appearance: {
        clockFormat: appearance.clockFormat === "12h" ? "12h" : "24h",
        dateFormat: appearance.dateFormat === "short" ? "short" : "long",
        enhancedAnimations: booleanOr(appearance.enhancedAnimations, true),
        hdrHighlights: booleanOr(appearance.hdrHighlights, true),
        theme: sanitizeTheme(appearance.theme, layout),
        glass: appearance.glass === "tinted" ? "tinted" : "clear",
        reduceTransparency: booleanOr(appearance.reduceTransparency, false)
      }
    };
  }
  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    const [header, payload] = dataUrl.split(",", 2);
    if (!payload) return null;
    const mime = header.match(/^data:([^;,]+)/)?.[1] ?? "application/octet-stream";
    try {
      const decoded = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
      return new Blob([bytes], { type: mime });
    } catch {
      return null;
    }
  }
  function canonicalUrl(value) {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.toLowerCase();
  }
  function dedupId(key) {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `dedup-${(hash >>> 0).toString(36)}`;
  }
  function sanitizeTheme(theme, layout) {
    if (theme === "dark") return "dark";
    if (theme === "light") return typeof layout.openInNewTab === "boolean" ? "light" : "auto";
    return "auto";
  }
  function sanitizeBookmarkIcon(value) {
    const icon = sanitizeRemoteUrl(value, true);
    return icon.startsWith("data:") && icon.length > MAX_INLINE_ICON_LENGTH ? "" : icon;
  }
  function sanitizeWallpaperValue(value) {
    if (typeof value === "string" && (value === "" || /^(local|online)(-\d+)?$/.test(value))) return value;
    return sanitizeRemoteUrl(value, true);
  }
  function sanitizeFraming(value) {
    const source = isRecord(value) ? value : {};
    const fallback = DEFAULT_SETTINGS.wallpaper.framing;
    return {
      scale: clampNumber(source.scale, 0.05, 5, fallback.scale),
      x: clampNumber(source.x, 0, 1, fallback.x),
      y: clampNumber(source.y, 0, 1, fallback.y)
    };
  }
  function hostList(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    for (const entry of value) {
      const host = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      if (!host || host.length > MAX_RECENT_HOST_LENGTH || /\s/.test(host)) continue;
      if (!result.includes(host)) result.push(host);
      if (result.length === MAX_RECENT_EXCLUDED) break;
    }
    return result;
  }
  function booleanOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }
  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  var DEFAULT_SETTINGS, MAX_INLINE_ICON_LENGTH, MAX_RECENT_EXCLUDED, MAX_RECENT_HOST_LENGTH;
  var init_backup = __esm({
    "src/core/backup.ts"() {
      "use strict";
      init_utils();
      DEFAULT_SETTINGS = {
        layout: {
          showClock: true,
          showSearch: true,
          showBookmarks: true,
          showStatus: true,
          showRecent: true,
          openInNewTab: false,
          searchEngine: "google",
          dockSource: "recent",
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
          type: "gradient",
          value: "",
          blur: 0,
          overlay: 12,
          framing: { scale: 1, x: 0.5, y: 0.5 },
          idleHide: true,
          pauseOnBattery: true,
          pauseWhenHidden: true,
          sound: false
        },
        appearance: {
          clockFormat: "24h",
          dateFormat: "long",
          enhancedAnimations: true,
          hdrHighlights: true,
          theme: "auto",
          glass: "clear",
          reduceTransparency: false
        }
      };
      MAX_INLINE_ICON_LENGTH = 4096;
      MAX_RECENT_EXCLUDED = 500;
      MAX_RECENT_HOST_LENGTH = 200;
    }
  });

  // src/core/media-store.ts
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u58C1\u7EB8"));
      reader.readAsDataURL(blob);
    });
  }
  var DATABASE, STORE, MediaStore, mediaStore;
  var init_media_store = __esm({
    "src/core/media-store.ts"() {
      "use strict";
      init_backup();
      DATABASE = "infinity-wallpaper";
      STORE = "wallpapers";
      MediaStore = class {
        async get(kind) {
          const database = await this.open();
          try {
            return await new Promise((resolve, reject) => {
              const request = database.transaction(STORE, "readonly").objectStore(STORE).get(kind);
              request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
              request.onerror = () => reject(request.error ?? new Error("\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u58C1\u7EB8"));
            });
          } finally {
            database.close();
          }
        }
        async set(kind, value) {
          const database = await this.open();
          try {
            await new Promise((resolve, reject) => {
              const transaction = database.transaction(STORE, "readwrite");
              transaction.objectStore(STORE).put(value, kind);
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error ?? new Error("\u65E0\u6CD5\u4FDD\u5B58\u672C\u5730\u58C1\u7EB8"));
              transaction.onabort = () => reject(transaction.error ?? new Error("\u672C\u5730\u58C1\u7EB8\u5B58\u50A8\u5DF2\u4E2D\u6B62"));
            });
          } finally {
            database.close();
          }
        }
        async clear(kind) {
          const database = await this.open();
          try {
            await new Promise((resolve, reject) => {
              const transaction = database.transaction(STORE, "readwrite");
              transaction.objectStore(STORE).delete(kind);
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error ?? new Error("\u65E0\u6CD5\u5220\u9664\u672C\u5730\u58C1\u7EB8"));
              transaction.onabort = () => reject(transaction.error ?? new Error("\u672C\u5730\u58C1\u7EB8\u5220\u9664\u5DF2\u4E2D\u6B62"));
            });
          } finally {
            database.close();
          }
        }
        async clearAll() {
          await Promise.all([this.clear("image"), this.clear("video")]);
        }
        async export() {
          const [image, video] = await Promise.all([this.get("image"), this.get("video")]);
          return {
            image: image ? await blobToDataUrl(image) : null,
            video: video ? await blobToDataUrl(video) : null
          };
        }
        async import(value, replace = true) {
          if (!isRecord(value)) {
            if (replace) await this.clearAll();
            return;
          }
          for (const kind of ["image", "video"]) {
            const blob = dataUrlToBlob(value[kind]);
            if (blob) await this.set(kind, blob);
            else if (replace) await this.clear(kind);
          }
        }
        open() {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("\u65E0\u6CD5\u6253\u5F00\u58C1\u7EB8\u6570\u636E\u5E93"));
          });
        }
      };
      mediaStore = new MediaStore();
    }
  });

  // src/core/bookmark-storage.ts
  function bookmarkChunkKey(index) {
    return `${CHUNK_PREFIX}${index}`;
  }
  function encodeBookmarks(bookmarks) {
    const encoder = new TextEncoder();
    const chunks = [];
    let current = [];
    let size = 2;
    bookmarks.forEach((bookmark) => {
      const bytes = encoder.encode(JSON.stringify(bookmark)).length + 1;
      if (bytes + 2 > ITEM_BUDGET) throw new Error(`\u4E66\u7B7E\u201C${bookmark.name}\u201D\u6570\u636E\u8FC7\u5927\uFF0C\u65E0\u6CD5\u540C\u6B65`);
      if (current.length && size + bytes > ITEM_BUDGET) {
        chunks.push(current);
        current = [];
        size = 2;
      }
      current.push(bookmark);
      size += bytes;
    });
    if (current.length) chunks.push(current);
    const values = { [BOOKMARK_CHUNKS_KEY]: chunks.length };
    chunks.forEach((chunk, index) => {
      values[bookmarkChunkKey(index)] = chunk;
    });
    return { values, count: chunks.length };
  }
  function decodeBookmarks(stored) {
    const count = stored[BOOKMARK_CHUNKS_KEY];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      return Array.from({ length: count }, (_, index) => stored[bookmarkChunkKey(index)]).flatMap((chunk) => Array.isArray(chunk) ? chunk : []);
    }
    const legacy = stored[LEGACY_BOOKMARKS_KEY];
    return Array.isArray(legacy) ? legacy : [];
  }
  function storedChunkCount(stored) {
    const count = stored[BOOKMARK_CHUNKS_KEY];
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
  }
  function staleBookmarkKeys(previousCount, nextCount, hasLegacy) {
    const keys = hasLegacy ? [LEGACY_BOOKMARKS_KEY] : [];
    for (let index = nextCount; index < previousCount; index += 1) keys.push(bookmarkChunkKey(index));
    return keys;
  }
  var LEGACY_BOOKMARKS_KEY, BOOKMARK_CHUNKS_KEY, CHUNK_PREFIX, ITEM_BUDGET;
  var init_bookmark_storage = __esm({
    "src/core/bookmark-storage.ts"() {
      "use strict";
      LEGACY_BOOKMARKS_KEY = "bookmarks";
      BOOKMARK_CHUNKS_KEY = "bookmarkChunks";
      CHUNK_PREFIX = "bookmarks.";
      ITEM_BUDGET = 7600;
    }
  });

  // src/core/icon-audit.ts
  function siteKeyOf(url) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      const parts = host.split(".");
      const take = parts.length >= 3 && TWO_LEVEL_SUFFIX.test(parts.slice(-2).join(".")) ? 3 : 2;
      return parts.slice(-take).join(".");
    } catch {
      return "";
    }
  }
  function sharedIconUrls(bookmarks) {
    const usage = /* @__PURE__ */ new Map();
    bookmarks.forEach((bookmark) => {
      if (!bookmark.icon.startsWith("http")) return;
      const sites = usage.get(bookmark.icon) ?? /* @__PURE__ */ new Set();
      sites.add(siteKeyOf(bookmark.url));
      usage.set(bookmark.icon, sites);
    });
    return new Set(
      [...usage.entries()].filter(([, sites]) => sites.size > 1).map(([icon]) => icon)
    );
  }
  function stripSharedIcons(bookmarks, shared = sharedIconUrls(bookmarks)) {
    if (!shared.size) return { bookmarks, cleared: 0 };
    let cleared = 0;
    const next = bookmarks.map((bookmark) => {
      if (!shared.has(bookmark.icon)) return bookmark;
      cleared += 1;
      return { ...bookmark, icon: "" };
    });
    return { bookmarks: next, cleared };
  }
  var TWO_LEVEL_SUFFIX;
  var init_icon_audit = __esm({
    "src/core/icon-audit.ts"() {
      "use strict";
      TWO_LEVEL_SUFFIX = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
    }
  });

  // src/core/storage.ts
  function area(name) {
    return chrome.storage[name];
  }
  function storageGet(keys, areaName = "sync") {
    return new Promise((resolve, reject) => {
      area(areaName).get(keys, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result ?? {});
      });
    });
  }
  function storageSet(values, areaName = "sync") {
    return new Promise((resolve, reject) => {
      area(areaName).set(values, () => {
        if (chrome.runtime.lastError) reject(new Error(describeWriteError(chrome.runtime.lastError.message)));
        else resolve();
      });
    });
  }
  function storageRemove(keys, areaName = "sync") {
    return new Promise((resolve, reject) => {
      area(areaName).remove(keys, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }
  function storageClear(areaName = "sync") {
    return new Promise((resolve, reject) => {
      area(areaName).clear(() => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }
  function describeWriteError(message = "") {
    if (/QUOTA_BYTES/i.test(message)) return "Chrome \u540C\u6B65\u7A7A\u95F4\u5DF2\u6EE1\uFF08\u4E0A\u9650\u7EA6 100 KB\uFF09\uFF0C\u8BF7\u5220\u9664\u90E8\u5206\u4E66\u7B7E\u6216\u81EA\u5B9A\u4E49\u56FE\u6807\u540E\u91CD\u8BD5";
    if (/MAX_WRITE_OPERATIONS/i.test(message)) return "\u64CD\u4F5C\u592A\u9891\u7E41\uFF0CChrome \u6682\u65F6\u9650\u5236\u4E86\u540C\u6B65\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5";
    return message || "\u4FDD\u5B58\u5931\u8D25";
  }
  var init_storage = __esm({
    "src/core/storage.ts"() {
      "use strict";
    }
  });

  // src/core/store.ts
  function initialState() {
    return {
      bookmarks: [],
      folders: ["\u5168\u90E8"],
      settings: structuredClone(DEFAULT_SETTINGS),
      recentSearches: [],
      lastBackupPrompt: 0
    };
  }
  function normalizeBookmarkInput(input, state, id = `${Date.now()}-${crypto.randomUUID()}`) {
    const url = normalizeUrl(input.url);
    if (!url) throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u7684\u7F51\u5740");
    if (url.length > 2048) throw new Error("\u7F51\u5740\u8FC7\u957F\uFF0C\u65E0\u6CD5\u540C\u6B65\u4FDD\u5B58");
    const icon = sanitizeRemoteUrl(input.icon, true);
    if (icon.startsWith("data:") && icon.length > MAX_INLINE_ICON_LENGTH) {
      throw new Error("\u5185\u5D4C\u56FE\u6807\u8FC7\u5927\uFF0C\u8BF7\u6539\u7528\u56FE\u6807\u7F51\u5740");
    }
    const folder = state.folders.includes(input.folder) ? input.folder : "\u5168\u90E8";
    return {
      id,
      url,
      folder,
      name: cleanText(input.name, 160) || new URL(url).hostname,
      icon,
      order: state.bookmarks.filter((bookmark) => bookmark.folder === folder && String(bookmark.id) !== String(id)).length
    };
  }
  function normalizeFolders(value, bookmarks) {
    const folders = /* @__PURE__ */ new Set(["\u5168\u90E8"]);
    if (Array.isArray(value)) value.forEach((item) => {
      const name = cleanText(item, 80);
      if (name) folders.add(name);
    });
    bookmarks.forEach((bookmark) => folders.add(bookmark.folder));
    return [...folders];
  }
  function normalizeRecentSearches(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => cleanText(item, 200)).filter(Boolean).slice(0, 20);
  }
  function normalizeOrders(bookmarks) {
    new Set(bookmarks.map((bookmark) => bookmark.folder)).forEach((folder) => normalizeFolderOrder(bookmarks, folder));
  }
  function normalizeFolderOrder(bookmarks, folder) {
    bookmarks.filter((bookmark) => bookmark.folder === folder).sort(compareBookmarks).forEach((bookmark, index) => {
      bookmark.order = index;
    });
  }
  function compareBookmarks(left, right) {
    return left.order - right.order || String(left.id).localeCompare(String(right.id));
  }
  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  var ALL_CHANGES, AppStore, appStore;
  var init_store = __esm({
    "src/core/store.ts"() {
      "use strict";
      init_backup();
      init_bookmark_storage();
      init_icon_audit();
      init_storage();
      init_utils();
      ALL_CHANGES = [
        "bookmarks",
        "folders",
        "recentSearches",
        "lastBackupPrompt",
        "settings.appearance",
        "settings.wallpaper",
        "settings.layout"
      ];
      AppStore = class extends EventTarget {
        stateValue = initialState();
        initialized = false;
        bookmarkChunks = 0;
        hasLegacyBookmarks = false;
        get state() {
          return this.stateValue;
        }
        async init(force = false) {
          if (this.initialized && !force) return;
          const stored = await storageGet(null);
          this.bookmarkChunks = storedChunkCount(stored);
          this.hasLegacyBookmarks = LEGACY_BOOKMARKS_KEY in stored;
          const decoded = decodeBookmarks(stored);
          const sanitized = sanitizeBookmarks(decoded);
          const shared = sharedIconUrls(sanitized);
          const bookmarks = stripSharedIcons(sanitized, shared).bookmarks;
          const folders = normalizeFolders(stored.folders, bookmarks);
          this.stateValue = {
            bookmarks,
            folders,
            settings: sanitizeSettings(stored.settings),
            recentSearches: normalizeRecentSearches(stored.recentSearches),
            lastBackupPrompt: finiteNumber(stored.lastBackupPrompt, 0)
          };
          this.initialized = true;
          this.emit(ALL_CHANGES);
          const repairedIds = hasDuplicateBookmarkIds(decoded);
          if (shared.size || repairedIds) {
            void this.persistRepairs(shared, repairedIds).catch(() => void 0);
          }
        }
        /** 修好的数据写回同步存储，串行执行以免两次 commit 互相覆盖。 */
        async persistRepairs(shared, repairedIds) {
          if (shared.size) await this.applySharedIconRepair(shared);
          if (repairedIds) await this.commit(() => void 0, ["bookmarks"]);
        }
        async updateSettings(section, patch) {
          await this.commit((draft) => {
            draft.settings = sanitizeSettings({
              ...draft.settings,
              [section]: { ...draft.settings[section], ...patch }
            });
          }, ["settings"], [`settings.${section}`]);
        }
        /** 把站点从「常访问」里移除：只写屏蔽名单，不碰浏览器历史，可以随时恢复。 */
        async removeRecentSite(host) {
          const value = String(host ?? "").trim().toLowerCase();
          if (!value) return false;
          const current = this.stateValue.settings.layout.recentExcluded;
          if (current.includes(value)) return false;
          await this.commit((draft) => {
            draft.settings.layout.recentExcluded = [...current, value];
          }, ["settings"], ["settings.layout"]);
          return true;
        }
        /** 把单个站点从屏蔽名单中移除（恢复显示），返回是否成功。 */
        async restoreRecentSite(host) {
          const value = String(host ?? "").trim().toLowerCase();
          if (!value) return false;
          const current = this.stateValue.settings.layout.recentExcluded;
          if (!current.includes(value)) return false;
          await this.commit((draft) => {
            draft.settings.layout.recentExcluded = current.filter((item) => item !== value);
          }, ["settings"], ["settings.layout"]);
          return true;
        }
        /** 清掉整个屏蔽名单，返回恢复了几个站点。 */
        async restoreRecentSites() {
          const count = this.stateValue.settings.layout.recentExcluded.length;
          if (!count) return 0;
          await this.commit((draft) => {
            draft.settings.layout.recentExcluded = [];
          }, ["settings"], ["settings.layout"]);
          return count;
        }
        async addFolder(value) {
          const name = cleanText(value, 80);
          if (!name || this.stateValue.folders.includes(name)) return false;
          await this.commit((draft) => {
            draft.folders.push(name);
          }, ["folders"]);
          return true;
        }
        /**
         * 把文件夹挪到「全部」之后的第 index 位（0 起，不含「全部」）。
         * 返回是否真的发生了变化，方便调用方跳过无意义的渲染。
         */
        async moveFolder(from, index) {
          if (!from || from === "\u5168\u90E8") return false;
          const current = this.stateValue.folders;
          if (!current.includes(from)) return false;
          const rest = current.filter((folder) => folder !== "\u5168\u90E8" && folder !== from);
          const requested = Number.isFinite(index) ? Math.trunc(index) : rest.length;
          rest.splice(Math.max(0, Math.min(requested, rest.length)), 0, from);
          const next = ["\u5168\u90E8", ...rest];
          if (next.length === current.length && next.every((folder, position) => folder === current[position])) {
            return false;
          }
          await this.commit((draft) => {
            draft.folders = next;
          }, ["folders"]);
          return true;
        }
        async renameFolder(from, to) {
          const name = cleanText(to, 80);
          if (!name || from === "\u5168\u90E8" || name !== from && this.stateValue.folders.includes(name)) return false;
          await this.commit((draft) => {
            draft.folders = draft.folders.map((folder) => folder === from ? name : folder);
            draft.bookmarks.forEach((bookmark) => {
              if (bookmark.folder === from) bookmark.folder = name;
            });
            normalizeOrders(draft.bookmarks);
          }, ["folders", "bookmarks"]);
          return true;
        }
        async deleteFolder(folder) {
          if (folder === "\u5168\u90E8") return;
          await this.commit((draft) => {
            draft.folders = draft.folders.filter((item) => item !== folder);
            draft.bookmarks.forEach((bookmark) => {
              if (bookmark.folder === folder) bookmark.folder = "\u5168\u90E8";
            });
            normalizeOrders(draft.bookmarks);
          }, ["folders", "bookmarks"]);
        }
        async addBookmark(input) {
          const bookmark = normalizeBookmarkInput(input, this.stateValue);
          await this.commit((draft) => {
            draft.bookmarks.push(bookmark);
          }, ["bookmarks"]);
          return bookmark;
        }
        async updateBookmark(id, input) {
          await this.commit((draft) => {
            const index = draft.bookmarks.findIndex((bookmark) => String(bookmark.id) === String(id));
            if (index < 0) throw new Error("\u627E\u4E0D\u5230\u8BE5\u4E66\u7B7E");
            const previous = draft.bookmarks[index];
            const next = normalizeBookmarkInput(input, draft, previous.id);
            next.order = previous.folder === next.folder ? previous.order : draft.bookmarks.filter((bookmark) => bookmark.folder === next.folder).length;
            draft.bookmarks[index] = next;
            normalizeOrders(draft.bookmarks);
          }, ["bookmarks"]);
        }
        /** 清掉被多个不同站点共用的远程图标（来源数据串号），返回清理条数。 */
        async clearSharedIcons() {
          const shared = sharedIconUrls(this.stateValue.bookmarks);
          return this.applySharedIconRepair(shared);
        }
        async applySharedIconRepair(shared) {
          if (!shared.size) return 0;
          let cleared = 0;
          await this.commit((draft) => {
            draft.bookmarks = draft.bookmarks.map((bookmark) => {
              if (!shared.has(bookmark.icon)) return bookmark;
              cleared += 1;
              return { ...bookmark, icon: "" };
            });
          }, ["bookmarks"]);
          return cleared;
        }
        async deleteBookmark(id) {
          await this.commit((draft) => {
            draft.bookmarks = draft.bookmarks.filter((bookmark) => String(bookmark.id) !== String(id));
            normalizeOrders(draft.bookmarks);
          }, ["bookmarks"]);
        }
        async moveBookmark(id, targetFolder, targetId) {
          await this.commit((draft) => {
            const bookmark = draft.bookmarks.find((item) => String(item.id) === String(id));
            if (!bookmark) throw new Error("\u627E\u4E0D\u5230\u62D6\u52A8\u7684\u4E66\u7B7E");
            const destination = draft.folders.includes(targetFolder) ? targetFolder : "\u5168\u90E8";
            const source = bookmark.folder;
            bookmark.folder = destination;
            const destinationList = draft.bookmarks.filter((item) => item.folder === destination && String(item.id) !== String(id)).sort(compareBookmarks);
            const foundIndex = targetId === void 0 ? destinationList.length : destinationList.findIndex((item) => String(item.id) === String(targetId));
            const targetIndex = foundIndex < 0 ? destinationList.length : foundIndex;
            destinationList.splice(targetIndex, 0, bookmark);
            destinationList.forEach((item, index) => {
              item.order = index;
            });
            if (source !== destination) normalizeFolderOrder(draft.bookmarks, source);
          }, ["bookmarks"]);
        }
        async removeRecentSearch(query) {
          await this.commit((draft) => {
            draft.recentSearches = draft.recentSearches.filter((item) => item !== query);
          }, ["recentSearches"]);
        }
        async saveRecentSearch(query) {
          const value = cleanText(query, 200);
          if (!value) return;
          await this.commit((draft) => {
            draft.recentSearches = [value, ...draft.recentSearches.filter((item) => item !== value)].slice(0, 20);
          }, ["recentSearches"]);
        }
        async setLastBackupPrompt(value = Date.now()) {
          await this.commit((draft) => {
            draft.lastBackupPrompt = value;
          }, ["lastBackupPrompt"]);
        }
        async replaceImportedData(data) {
          const next = initialState();
          next.bookmarks = stripSharedIcons(sanitizeBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : [])).bookmarks;
          next.folders = normalizeFolders(data.folders, next.bookmarks);
          next.settings = sanitizeSettings(data.settings);
          next.recentSearches = normalizeRecentSearches(data.recentSearches);
          next.lastBackupPrompt = finiteNumber(data.lastBackupPrompt, 0);
          const encoded = encodeBookmarks(next.bookmarks);
          const values = {
            ...encoded.values,
            folders: next.folders,
            settings: next.settings,
            recentSearches: next.recentSearches,
            lastBackupPrompt: next.lastBackupPrompt,
            ...Array.isArray(data.todos) ? { todos: data.todos } : {}
          };
          await storageSet(values);
          const staleKeys = [
            ...["todos"].filter((key) => !(key in values)),
            ...staleBookmarkKeys(this.bookmarkChunks, encoded.count, this.hasLegacyBookmarks)
          ];
          if (staleKeys.length) await storageRemove(staleKeys);
          this.bookmarkChunks = encoded.count;
          this.hasLegacyBookmarks = false;
          this.stateValue = next;
          this.initialized = true;
          this.emit(ALL_CHANGES);
        }
        async reset() {
          await storageClear("sync");
          this.bookmarkChunks = 0;
          this.hasLegacyBookmarks = false;
          this.stateValue = initialState();
          this.emit(ALL_CHANGES);
        }
        async commit(mutator, keys, changes = keys) {
          const draft = structuredClone(this.stateValue);
          mutator(draft);
          const values = {};
          let bookmarkChunks = null;
          keys.forEach((key) => {
            if (key !== "bookmarks") {
              values[key] = draft[key];
              return;
            }
            const encoded = encodeBookmarks(draft.bookmarks);
            Object.assign(values, encoded.values);
            bookmarkChunks = encoded.count;
          });
          await storageSet(values);
          this.stateValue = draft;
          if (bookmarkChunks !== null) await this.dropStaleBookmarkKeys(bookmarkChunks);
          this.emit(changes);
        }
        /** Stale chunks are harmless to readers, so a failed cleanup never rolls back a save. */
        async dropStaleBookmarkKeys(nextCount) {
          const stale = staleBookmarkKeys(this.bookmarkChunks, nextCount, this.hasLegacyBookmarks);
          this.bookmarkChunks = nextCount;
          if (!stale.length) return;
          try {
            await storageRemove(stale);
            this.hasLegacyBookmarks = false;
          } catch {
          }
        }
        emit(changes) {
          this.dispatchEvent(new CustomEvent("change", { detail: { state: this.stateValue, changes } }));
        }
      };
      appStore = new AppStore();
    }
  });

  // src/core/backup-service.ts
  function dateStamp() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  var LAST_EXPORT_AT_KEY, BackupService, backupService;
  var init_backup_service = __esm({
    "src/core/backup-service.ts"() {
      "use strict";
      init_backup();
      init_media_store();
      init_store();
      init_storage();
      LAST_EXPORT_AT_KEY = "lastBackupExportAt";
      BackupService = class {
        async exportData() {
          return {
            version: "2.0",
            exportDate: (/* @__PURE__ */ new Date()).toISOString(),
            data: await this.collectData(),
            localMedia: await mediaStore.export()
          };
        }
        /** Backups keep the flat 2.0 layout even though sync storage now chunks bookmarks. */
        async collectData() {
          const { todos } = await storageGet(["todos"]);
          return {
            ...structuredClone(appStore.state),
            ...Array.isArray(todos) ? { todos } : {}
          };
        }
        async importData(value) {
          if (!isRecord(value) || !value.version || !isRecord(value.data)) {
            throw new Error("\u5907\u4EFD\u6587\u4EF6\u683C\u5F0F\u65E0\u6548");
          }
          const data = sanitizeImportedData(value.data);
          if (Object.hasOwn(value, "localMedia")) await mediaStore.import(value.localMedia, true);
          const settings = data.settings;
          if (isRecord(settings) && isRecord(settings.wallpaper)) {
            const wallpaper = settings.wallpaper;
            if (wallpaper.type === "local" && typeof wallpaper.value === "string" && wallpaper.value.startsWith("data:image/")) {
              const image = dataUrlToBlob(wallpaper.value);
              if (!image) throw new Error("\u65E7\u5907\u4EFD\u4E2D\u7684\u672C\u5730\u58C1\u7EB8\u65E0\u6548");
              await mediaStore.set("image", image);
              wallpaper.value = "local";
            }
          }
          await appStore.replaceImportedData(data);
        }
        download(data, filename = `infinity-newtab-backup-${dateStamp()}.json`) {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = filename;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1e3);
        }
        async read(file) {
          try {
            return JSON.parse(await file.text());
          } catch {
            throw new Error("\u65E0\u6CD5\u8BFB\u53D6 JSON \u5907\u4EFD\u6587\u4EF6");
          }
        }
        async createBackup() {
          const data = await this.exportData();
          this.download(data);
          const exportedAt = data.exportDate ?? (/* @__PURE__ */ new Date()).toISOString();
          await storageSet({ [LAST_EXPORT_AT_KEY]: exportedAt }, "local").catch(() => void 0);
          return exportedAt;
        }
        async loadLastExportAt() {
          const value = await storageGet(LAST_EXPORT_AT_KEY, "local").catch(() => ({}));
          return typeof value[LAST_EXPORT_AT_KEY] === "string" ? value[LAST_EXPORT_AT_KEY] : "";
        }
      };
      backupService = new BackupService();
    }
  });

  // src/core/webdav-bridge.ts
  function isWebDavRequestMessage(value) {
    if (!value || typeof value !== "object") return false;
    const message = value;
    return message.type === WEBDAV_REQUEST_TYPE && typeof message.method === "string" && typeof message.url === "string" && typeof message.timeout === "number" && (message.body === null || typeof message.body === "string") && typeof message.headers === "object" && message.headers !== null;
  }
  var WEBDAV_REQUEST_TYPE;
  var init_webdav_bridge = __esm({
    "src/core/webdav-bridge.ts"() {
      "use strict";
      WEBDAV_REQUEST_TYPE = "infinity-newtab-webdav-request";
    }
  });

  // src/core/webdav.ts
  function sanitizeWebDavAccount(value) {
    const record = isRecord(value) ? value : {};
    const username = typeof record.username === "string" ? record.username.trim().slice(0, MAX_CREDENTIAL_LENGTH) : "";
    const password = typeof record.password === "string" ? record.password.slice(0, MAX_CREDENTIAL_LENGTH) : "";
    const file = sanitizeFileName(typeof record.file === "string" ? record.file : "");
    return {
      url: sanitizeBaseUrl(typeof record.url === "string" ? record.url : ""),
      username,
      password,
      file
    };
  }
  function sanitizeBaseUrl(value) {
    const candidate = value.trim().slice(0, MAX_URL_LENGTH);
    if (!candidate) return "";
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      url.username = "";
      url.password = "";
      return url.href.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }
  function sanitizeFileName(value) {
    const file = value.trim().slice(0, MAX_FILE_LENGTH);
    return file && file !== "." && file !== ".." && !UNUSABLE_FILE_NAME.test(file) ? file : DEFAULT_WEBDAV_FILE;
  }
  function webDavHref(account) {
    return `${account.url}/${sanitizeFileName(account.file)}`;
  }
  async function loadWebDavAccount() {
    const value = await storageGet(WEBDAV_STORAGE_KEY, "local");
    const account = sanitizeWebDavAccount(value[WEBDAV_STORAGE_KEY]);
    return account.url ? account : null;
  }
  async function saveWebDavBackupMeta(meta) {
    await storageSet({
      [WEBDAV_META_STORAGE_KEY]: {
        exists: Boolean(meta.exists),
        modified: meta.modified.slice(0, 64),
        size: Number.isFinite(meta.size) ? meta.size : 0
      }
    }, "local");
  }
  var WEBDAV_STORAGE_KEY, WEBDAV_META_STORAGE_KEY, DEFAULT_WEBDAV_FILE, MAX_URL_LENGTH, MAX_CREDENTIAL_LENGTH, MAX_FILE_LENGTH, UNUSABLE_FILE_NAME;
  var init_webdav = __esm({
    "src/core/webdav.ts"() {
      "use strict";
      init_base64();
      init_backup();
      init_storage();
      init_webdav_bridge();
      WEBDAV_STORAGE_KEY = "webdav";
      WEBDAV_META_STORAGE_KEY = "webdavBackupMeta";
      DEFAULT_WEBDAV_FILE = "infinity-newtab-backup.json";
      MAX_URL_LENGTH = 400;
      MAX_CREDENTIAL_LENGTH = 200;
      MAX_FILE_LENGTH = 120;
      UNUSABLE_FILE_NAME = /[\s/\\?*|#:"<>|]/;
    }
  });

  // src/core/wallpaper-bridge.ts
  function isBingWallpaperRequestMessage(value) {
    return Boolean(value && typeof value === "object" && value.type === BING_WALLPAPER_REQUEST_TYPE);
  }
  var BING_WALLPAPER_REQUEST_TYPE;
  var init_wallpaper_bridge = __esm({
    "src/core/wallpaper-bridge.ts"() {
      "use strict";
      BING_WALLPAPER_REQUEST_TYPE = "infinity-newtab-bing-wallpaper-request";
    }
  });

  // src/background.ts
  var require_background = __commonJS({
    "src/background.ts"() {
      init_base64();
      init_backup_service();
      init_store();
      init_webdav();
      init_webdav_bridge();
      init_wallpaper_bridge();
      var MAX_TIMEOUT = 6e5;
      var BING_ARCHIVE_URL = "https://cn.bing.com/HPImageArchive.aspx";
      var BING_BASE_URL = "https://cn.bing.com";
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (isWebDavRequestMessage(message)) {
          void perform(message).then(sendResponse).catch((error) => sendResponse({ error: describeTransportError(error) }));
          return true;
        }
        if (isBingWallpaperRequestMessage(message)) {
          void fetchBingWallpaper().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "\u83B7\u53D6\u5FC5\u5E94\u58C1\u7EB8\u5931\u8D25" }));
          return true;
        }
        return false;
      });
      async function perform(message) {
        try {
          const body = message.body ? base64ToBytes(message.body) : void 0;
          const response = await fetch(message.url, {
            method: message.method,
            headers: message.headers,
            body,
            signal: AbortSignal.timeout(Math.min(Math.max(message.timeout, 1e3), MAX_TIMEOUT))
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { ok: response.ok, status: response.status, body: bytes.length ? bytesToBase64(bytes) : null };
        } catch (error) {
          return { error: describeTransportError(error) };
        }
      }
      async function fetchBingWallpaper() {
        const randomIdx = Math.floor(Math.random() * 8);
        let response;
        try {
          response = await fetch(`${BING_ARCHIVE_URL}?format=js&idx=${randomIdx}&n=8&t=${Date.now()}`, { cache: "no-store" });
        } catch {
          try {
            response = await fetch(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=${randomIdx}&n=8&t=${Date.now()}`, { cache: "no-store" });
          } catch {
            return { ok: false, error: "\u65E0\u6CD5\u8FDE\u63A5\u5FC5\u5E94\u58C1\u7EB8\u670D\u52A1\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC" };
          }
        }
        if (!response.ok) return { ok: false, error: `\u58C1\u7EB8\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF08${response.status}\uFF09` };
        let data;
        try {
          data = await response.json();
        } catch {
          return { ok: false, error: "\u58C1\u7EB8\u6570\u636E\u89E3\u6790\u5931\u8D25" };
        }
        const list = data?.images;
        if (!Array.isArray(list) || list.length === 0) {
          return { ok: false, error: "\u672A\u83B7\u53D6\u5230\u6709\u6548\u7684\u98CE\u5149\u58C1\u7EB8\u6570\u636E" };
        }
        const chosen = list[Math.floor(Math.random() * list.length)];
        const rawUrl = chosen.url || (chosen.urlbase ? `${chosen.urlbase}_1920x1080.jpg` : "");
        if (!rawUrl) return { ok: false, error: "\u58C1\u7EB8\u5730\u5740\u65E0\u6548" };
        const imageUrl = rawUrl.startsWith("http") ? rawUrl : `${BING_BASE_URL}${rawUrl}`;
        let imgResponse;
        try {
          imgResponse = await fetch(imageUrl, { cache: "no-store" });
        } catch {
          return { ok: false, error: "\u4E0B\u8F7D\u58C1\u7EB8\u56FE\u7247\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC" };
        }
        if (!imgResponse.ok) return { ok: false, error: `\u4E0B\u8F7D\u58C1\u7EB8\u5931\u8D25\uFF08${imgResponse.status}\uFF09` };
        const bytes = new Uint8Array(await imgResponse.arrayBuffer());
        return {
          ok: true,
          body: bytesToBase64(bytes),
          contentType: imgResponse.headers.get("content-type") || "image/jpeg"
        };
      }
      function describeTransportError(error) {
        if (error instanceof DOMException && error.name === "TimeoutError") return "\u8BF7\u6C42\u8D85\u65F6\uFF0C\u670D\u52A1\u5668\u54CD\u5E94\u592A\u6162";
        if (error instanceof TypeError) return "\u65E0\u6CD5\u8FDE\u63A5\u670D\u52A1\u5668\uFF1A\u68C0\u67E5\u5730\u5740\u662F\u5426\u53EF\u8FBE\u3001\u7AEF\u53E3\u662F\u5426\u88AB\u9632\u706B\u5899\u62E6\u4E0B";
        return error instanceof Error ? error.message : "\u670D\u52A1\u5668\u8BF7\u6C42\u5931\u8D25";
      }
      chrome.runtime.onMessageExternal.addListener((request, _sender, sendResponse) => {
        if (!request || typeof request !== "object") return false;
        const msg = request;
        if (msg.type === "BACKUP_ALL_PING") {
          sendResponse({ ok: true, name: "Infinity New Tab", protocol: 1 });
          return false;
        }
        if (msg.type === "BACKUP_ALL_TRIGGER") {
          void (async () => {
            try {
              await appStore.init(true);
              const data = await backupService.exportData();
              const account = await loadWebDavAccount();
              if (account && account.url) {
                const headers = { "Content-Type": "application/json" };
                if (account.username || account.password) {
                  const raw = new TextEncoder().encode(`${account.username}:${account.password}`);
                  headers.Authorization = `Basic ${bytesToBase64(raw)}`;
                }
                const bodyText = JSON.stringify(data);
                const resp = await fetch(webDavHref(account), {
                  method: "PUT",
                  headers,
                  body: bodyText,
                  signal: AbortSignal.timeout(24e4)
                });
                if (!resp.ok) {
                  throw new Error(`WebDAV \u4E0A\u4F20\u5931\u8D25\uFF08HTTP ${resp.status}\uFF09`);
                }
                await saveWebDavBackupMeta({
                  exists: true,
                  modified: (/* @__PURE__ */ new Date()).toISOString(),
                  size: new TextEncoder().encode(bodyText).byteLength
                });
                const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
                sendResponse({
                  ok: true,
                  mode: "cloud+json",
                  filename: `infinity-newtab-backup-${stamp}.json`,
                  data,
                  message: "WebDAV \u540C\u6B65\u6210\u529F + \u5DF2\u5B58\u672C\u5730\u526F\u672C"
                });
              } else {
                const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
                sendResponse({
                  ok: true,
                  mode: "json",
                  filename: `infinity-newtab-backup-${stamp}.json`,
                  data,
                  message: "WebDAV \u672A\u914D\u7F6E\uFF0C\u5DF2\u5BFC\u51FA\u672C\u5730\u5907\u4EFD"
                });
              }
            } catch (error) {
              sendResponse({ ok: false, message: `\u5907\u4EFD\u5931\u8D25\uFF1A${describeTransportError(error)}` });
            }
          })();
          return true;
        }
        return false;
      });
    }
  });
  require_background();
})();
