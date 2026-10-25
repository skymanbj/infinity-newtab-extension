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

  // src/background.ts
  var require_background = __commonJS({
    "src/background.ts"() {
      init_base64();
      init_webdav_bridge();
      var MAX_TIMEOUT = 6e5;
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!isWebDavRequestMessage(message)) return false;
        void perform(message).then(sendResponse).catch((error) => sendResponse({ error: describeTransportError(error) }));
        return true;
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
      function describeTransportError(error) {
        if (error instanceof DOMException && error.name === "TimeoutError") return "\u8BF7\u6C42\u8D85\u65F6\uFF0C\u670D\u52A1\u5668\u54CD\u5E94\u592A\u6162";
        if (error instanceof TypeError) return "\u65E0\u6CD5\u8FDE\u63A5\u670D\u52A1\u5668\uFF1A\u68C0\u67E5\u5730\u5740\u662F\u5426\u53EF\u8FBE\u3001\u7AEF\u53E3\u662F\u5426\u88AB\u9632\u706B\u5899\u62E6\u4E0B";
        return error instanceof Error ? error.message : "\u670D\u52A1\u5668\u8BF7\u6C42\u5931\u8D25";
      }
    }
  });
  require_background();
})();
