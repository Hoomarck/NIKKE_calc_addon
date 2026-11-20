// SPDX-License-Identifier: GPL-3.0-or-later
/* =====================================================================
 * 轻量跨浏览器扩展 API 兼容垫片（Edge / Chromium MV3 优先）
 * ---------------------------------------------------------------------
 * 目标：
 *  1. 统一命名空间：Chromium（Edge / Chrome）只暴露 chrome.*，Firefox 暴露
 *     browser.*。直接写 browser.* 在 Edge 下会抛
 *     "ReferenceError: browser is not defined"，因此全部调用都经过本模块。
 *  2. 统一异步风格：Chromium 的异步 API 以回调为主，Firefox 以 Promise 为主。
 *     callApi() 会自动判断被调用方法的签名：
 *       - 声明参数多于实参 ⇒ 回调式（Chromium），自动补回调并读取 lastError
 *       - 否则 ⇒ Promise 式（Firefox / 新版 Chromium 已 Promise 化的 API）
 *     两种情况下都返回 Promise，业务代码可以无脑 await。
 *  3. 提供侧边栏（sidePanel）、消息发送等易错 API 的安全封装。
 * ===================================================================== */

const globalScope = typeof globalThis !== "undefined" ? globalThis : self;

/** 当前可用的扩展 API 命名空间：Edge/Chrome 取 chrome，Firefox 取 browser */
function resolveExtensionNamespace() {
  const chromeNs = globalScope.chrome;
  if (chromeNs && chromeNs.runtime && chromeNs.runtime.id) return chromeNs;
  const browserNs = globalScope.browser;
  if (browserNs && browserNs.runtime && browserNs.runtime.id) return browserNs;
  return chromeNs || browserNs || undefined;
}

export const ext = resolveExtensionNamespace();

/** 是否运行在带扩展 API 的页面里（在普通网页/单元测试中为 false） */
export const hasExtensionApi = Boolean(ext?.runtime?.id);

/** 是否由 Chromium 提供（Edge / Chrome），用于少数行为差异判断 */
export const isChromium =
  typeof globalScope.chrome !== "undefined" && Boolean(globalScope.chrome?.runtime);

const isPromiseLike = (value) =>
  Boolean(value) && typeof value === "object" && typeof value.then === "function";

/** 读取并清除 runtime.lastError（必须在回调内部同步读取） */
export function getRuntimeLastError() {
  try {
    const err = ext?.runtime?.lastError;
    if (!err) return null;
    return new Error(err.message || String(err));
  } catch {
    return null;
  }
}

/**
 * 以 Promise 形式调用任意扩展 API 方法。
 * @param {object|undefined} apiObject 例如 ext.storage.local
 * @param {string} method 方法名
 * @param {...any} args 实参（不要自行传回调）
 * @returns {Promise<any>}
 */
export function callApi(apiObject, method, ...args) {
  const fn = apiObject && apiObject[method];
  if (typeof fn !== "function") return Promise.resolve(undefined);

  // 声明参数数量 > 实参数量 ⇒ 该 API 需要回调（Chromium 风格）
  const needsCallback = fn.length > args.length;
  if (!needsCallback) {
    try {
      return Promise.resolve(fn.apply(apiObject, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOk = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleErr = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const callback = (value) => {
      const lastError = getRuntimeLastError();
      if (lastError) settleErr(lastError);
      else settleOk(value);
    };

    try {
      const maybePromise = fn.apply(apiObject, [...args, callback]);
      // 少数 Chromium 版本在传入回调时仍返回 Promise，两条路都兜住
      if (isPromiseLike(maybePromise)) maybePromise.then(settleOk, settleErr);
    } catch (error) {
      settleErr(error);
    }
  });
}

/** 发送运行时消息；无接收方或接收方报错时返回 null，绝不抛错 */
export function sendMessageSafe(message, extApi = ext) {
  const runtime = extApi?.runtime;
  if (typeof runtime?.sendMessage !== "function") return Promise.resolve(null);
  try {
    const result = runtime.sendMessage(message);
    if (!isPromiseLike(result)) return Promise.resolve(null);
    return Promise.resolve(result).then(
      (value) => (value === undefined ? null : value),
      () => null
    );
  } catch {
    return Promise.resolve(null);
  }
}

/** Edge / Chromium 是否支持侧边栏（sidePanel）API */
export function isSidePanelSupported(extApi = ext) {
  return typeof extApi?.sidePanel?.open === "function";
}

/**
 * 在当前窗口打开扩展侧边栏。
 * 注意：Chromium 要求在“用户手势”内同步调用 sidePanel.open()，
 * 因此本函数内部不 await 任何东西，必须在点击回调里直接调用。
 * @returns {boolean} 是否成功发起打开请求（不支持时返回 false，由调用方降级）
 */
export function openSidePanel(extApi = ext) {
  const sidePanel = extApi?.sidePanel;
  if (typeof sidePanel?.open !== "function") return false;

  const windowId = extApi?.windows?.WINDOW_ID_CURRENT ?? -2; // WINDOW_ID_CURRENT === -2
  try {
    const maybePromise = sidePanel.open({ windowId });
    if (isPromiseLike(maybePromise)) maybePromise.catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * 兜底识别当前页面是否处于 action 弹窗（POPUP）上下文。
 * 清单入口默认带 "?mode=popup"，此方法仅用于查询串丢失时的二次判定。
 * @returns {Promise<"popup"|"">}
 */
export async function detectPopupContext(extApi = ext) {
  const getContexts = extApi?.runtime?.getContexts;
  if (typeof getContexts !== "function") return "";
  try {
    const contexts = await callApi(extApi.runtime, "getContexts", { contextTypes: ["POPUP"] });
    const list = Array.isArray(contexts) ? contexts : [];
    const href = globalScope.location?.href || "";
    const hit = list.find(
      (ctx) =>
        ctx?.contextType === "POPUP"
        && (!href || !ctx.documentUrl || ctx.documentUrl === href)
    );
    return hit ? "popup" : "";
  } catch {
    return "";
  }
}
