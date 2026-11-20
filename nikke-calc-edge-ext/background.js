// SPDX-License-Identifier: GPL-3.0-or-later
// Edge / Chromium MV3 Service Worker 后台脚本：
// 管理 declarativeNetRequest 动态 Cookie 规则、计算器完整标签页的打开与聚焦

import { callApi, ext } from "./extension-api.js";

export const RULE_ID_BASE = 10000;

const SUPPORTED_MESSAGE_TYPES = new Set([
  "OPEN_CALCULATOR_TAB",
  "REGISTER_COOKIE_RULE",
  "UNREGISTER_COOKIE_RULES",
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 注册（或清空）按 _acct_id 隔离注入 Cookie 的动态规则
 */
export async function registerCookieRule({ gameUid, cookie } = {}, extApi = ext) {
  const dnr = extApi?.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) {
    return { ok: false, reason: "declarativeNetRequest unavailable" };
  }

  const uid = String(gameUid || "").trim();
  const cookieStr = String(cookie || "").trim();

  const existingRules = (await callApi(dnr, "getDynamicRules")) || [];
  const removeRuleIds = [...new Set([...existingRules.map((rule) => rule.id), RULE_ID_BASE])];

  const addRules = [];
  if (uid && cookieStr) {
    addRules.push({
      id: RULE_ID_BASE,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Cookie",
            operation: "set",
            value: cookieStr,
          },
        ],
      },
      condition: {
        regexFilter: `.*api\\.blablalink\\.com.*[?&]_acct_id=${escapeRegex(uid)}(?:&|$)`,
        resourceTypes: ["xmlhttprequest"],
      },
    });
  }

  await callApi(dnr, "updateDynamicRules", { removeRuleIds, addRules });
  return { ok: true, ruleCount: addRules.length };
}

/**
 * 注销所有动态 Cookie 规则
 */
export async function unregisterCookieRules(extApi = ext) {
  const dnr = extApi?.declarativeNetRequest;
  if (!dnr?.getDynamicRules || !dnr?.updateDynamicRules) {
    return { ok: false, removed: 0 };
  }

  const existingRules = (await callApi(dnr, "getDynamicRules")) || [];
  const removeRuleIds = [...new Set(existingRules.map((rule) => rule.id))];
  if (removeRuleIds.length === 0) {
    return { ok: true, removed: 0 };
  }

  await callApi(dnr, "updateDynamicRules", { removeRuleIds, addRules: [] });
  return { ok: true, removed: removeRuleIds.length };
}

/**
 * 打开或激活已有的洗词条计算器完整标签页
 */
export async function openOrFocusCalculatorTab(options = {}, extApi = ext) {
  const tabsApi = extApi?.tabs;
  const runtimeApi = extApi?.runtime;
  if (!tabsApi || !runtimeApi?.getURL) {
    return { ok: false, reason: "tabs or runtime unavailable" };
  }

  const baseUrl = runtimeApi.getURL("calculator.html");
  const existingTabs = (await callApi(tabsApi, "query", { url: `${baseUrl}*` })) || [];

  if (existingTabs.length > 0) {
    const targetTab = existingTabs[0];
    await callApi(tabsApi, "update", targetTab.id, { active: true });
    if (targetTab.windowId != null && extApi?.windows?.update) {
      await callApi(extApi.windows, "update", targetTab.windowId, { focused: true }).catch(
        () => undefined
      );
    }
    return { ok: true, reused: true, tabId: targetTab.id };
  }

  const params = new URLSearchParams();
  if (options?.nameCode) params.set("nameCode", String(options.nameCode));
  if (options?.partIndex !== undefined && options?.partIndex !== null) {
    params.set("part", String(options.partIndex));
  }
  const targetUrl = params.toString() ? `${baseUrl}#${params.toString()}` : baseUrl;

  const created = await callApi(tabsApi, "create", { url: targetUrl, active: true });
  return { ok: true, reused: false, tabId: created?.id ?? null };
}

/**
 * 分发后台运行时消息
 */
export async function handleRuntimeMessage(message, extApi = ext) {
  const type = message?.type;
  const payload = message?.payload && typeof message.payload === "object"
    ? message.payload
    : message;

  switch (type) {
    case "OPEN_CALCULATOR_TAB":
      return openOrFocusCalculatorTab(payload, extApi);
    case "REGISTER_COOKIE_RULE":
      return registerCookieRule(payload, extApi);
    case "UNREGISTER_COOKIE_RULES":
      return unregisterCookieRules(extApi);
    default:
      return undefined;
  }
}

export function onRuntimeMessage(message, _sender, sendResponse) {
  if (!message || !SUPPORTED_MESSAGE_TYPES.has(message.type)) {
    return undefined;
  }

  const task = handleRuntimeMessage(message, ext);
  if (typeof sendResponse === "function") {
    // 返回 true 保持消息通道开启，供 sendResponse 异步回填（Chromium 必需）
    task
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return task;
}

ext?.runtime?.onMessage?.addListener?.(onRuntimeMessage);
