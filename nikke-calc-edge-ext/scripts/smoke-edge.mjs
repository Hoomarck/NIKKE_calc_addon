// SPDX-License-Identifier: GPL-3.0-or-later
/* =====================================================================
 * Edge 真机冒烟测试（开发用，不随扩展打包）
 * ---------------------------------------------------------------------
 * 用无头 Edge 真正加载本扩展，再通过 DevTools Protocol 逐项验证：
 *   1. manifest.json 可被 Chromium/Edge 解析（扩展被成功装入并分配 ID）
 *   2. MV3 Service Worker 以 ES Module 启动成功（无语法/导入错误）
 *   3. Edge 下 browser 全局不存在，chrome.* / sidePanel / DNR 均可用，
 *      证明兼容垫片消除了 "ReferenceError: browser is not defined"
 *   4. declarativeNetRequest 动态规则可写可删（Cookie 注入链路）
 *   5. 弹窗 / 侧边栏 / 计算器三个页面加载无 JS 异常，DOM 正常初始化
 *
 * 用法：node scripts/smoke-edge.mjs
 * 环境变量：
 *   NIKKE_EDGE_BIN        指定 msedge.exe 路径
 *   NIKKE_EDGE_DEBUG_PORT DevTools 端口（默认 9333）
 *   NIKKE_EDGE_LOAD_MODE  cdp（默认，需 Edge 138+）| flag（旧版用 --load-extension）
 * ===================================================================== */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(scriptDir, "..");
const PORT = Number(process.env.NIKKE_EDGE_DEBUG_PORT || 9333);
const LOAD_MODE = (process.env.NIKKE_EDGE_LOAD_MODE || "cdp").toLowerCase();
const EXPECTED_NAME = "NIKKE 装备洗词条期望计算器";

const EDGE_CANDIDATES = [
  process.env.NIKKE_EDGE_BIN,
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✔ ${message}`);
}

function findEdgeBinary() {
  for (const candidate of EDGE_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** 极简 CDP 会话：一个 WebSocket 支持多次命令调用与事件订阅 */
class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    });
  }

  static async open(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`无法连接 CDP: ${wsUrl}`)), { once: true });
    });
    return new CdpSession(socket);
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || "CDP 返回错误"));
      else resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      const text = details?.exception?.description || details?.text || "未知异常";
      this.#emit("exception", text);
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      this.#emit("exception", message.params.entry.text);
    }
  }

  #emit(name, payload) {
    for (const handler of this.listeners.get(name) || []) handler(payload);
  }

  on(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result?.result?.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // 忽略
    }
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

async function waitForVersion(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`DevTools 端点未就绪（端口 ${PORT}），可能是 Edge 未能以无头模式启动`);
}

async function listTargets() {
  try {
    return await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  } catch {
    return [];
  }
}

async function waitForWorkerTarget(extensionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const hit = targets.find(
      (target) => target.type === "service_worker" && (target.url || "").includes(extensionId)
    );
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

/** 遍历所有扩展 Service Worker，按 manifest 名称找出本扩展 */
async function findOwnWorkerByManifest() {
  const targets = await listTargets();
  for (const target of targets) {
    if (target.type !== "service_worker") continue;
    if (!/^chrome-extension:\/\/[a-p]{32}\//.test(target.url || "")) continue;
    try {
      const session = await CdpSession.open(target.webSocketDebuggerUrl);
      const info = await session.evaluate(
        "JSON.stringify({ name: chrome.runtime.getManifest().name, id: chrome.runtime.id })"
      );
      session.close();
      const parsed = JSON.parse(info || "{}");
      if (parsed.name === EXPECTED_NAME) return { target, id: parsed.id };
    } catch {
      // 其他内置扩展可能禁止求值，忽略
    }
  }
  return null;
}

/** 打开扩展页面并采集加载期间的 JS 异常 */
async function inspectExtensionPage(pageSession, url, probeExpression) {
  const errors = [];
  pageSession.on("exception", (text) => errors.push(text));

  await pageSession.send("Page.navigate", { url });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    try {
      ready = Boolean(
        await pageSession.evaluate("document.readyState === 'complete' && Boolean(window.ThemeCtl)")
      );
    } catch {
      ready = false;
    }
    if (ready) break;
  }

  const probeRaw = await pageSession.evaluate(probeExpression);
  return { ready, probe: JSON.parse(probeRaw || "{}"), errors };
}

async function main() {
  const edge = findEdgeBinary();
  if (!edge) throw new Error("未找到 msedge.exe，请用 NIKKE_EDGE_BIN 环境变量指定路径");

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "nikke-edge-smoke-"));
  console.log(`Edge     : ${edge}`);
  console.log(`扩展目录 : ${EXT_ROOT}`);
  console.log(`加载方式 : ${LOAD_MODE === "flag" ? "--load-extension" : "CDP Extensions.loadUnpacked"}`);
  console.log(`临时配置 : ${profileDir}\n`);

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  if (LOAD_MODE === "flag") {
    args.unshift(`--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`);
  }

  const child = spawn(edge, args, { stdio: "ignore", windowsHide: true });
  let browser = null;
  let pageSession = null;

  try {
    const version = await waitForVersion();
    console.log(`浏览器   : ${version.Browser}\n`);
    browser = await CdpSession.open(version.webSocketDebuggerUrl);

    let extensionId = "";
    if (LOAD_MODE === "flag") {
      const found = await findOwnWorkerByManifest();
      if (!found) throw new Error("未发现本扩展：--load-extension 可能被此 Edge 版本忽略");
      extensionId = found.id;
      console.log("扩展加载");
      assert(Boolean(extensionId), `扩展已装入，ID = ${extensionId}`);
    } else {
      let loaded;
      try {
        loaded = await browser.send("Extensions.loadUnpacked", { path: EXT_ROOT });
      } catch (error) {
        throw new Error(
          `Extensions.loadUnpacked 不可用（${error.message}）。请将 Edge 升级到 138+，或改用 NIKKE_EDGE_LOAD_MODE=flag 启动`
        );
      }
      extensionId = loaded?.id;
      console.log("扩展加载");
      assert(Boolean(extensionId), `manifest.json 被 Edge 正常解析，扩展 ID = ${extensionId}`);
    }

    const workerTarget = await waitForWorkerTarget(extensionId);
    assert(Boolean(workerTarget), "MV3 Service Worker 已注册并启动");

    const worker = await CdpSession.open(workerTarget.webSocketDebuggerUrl);
    const manifestProbe = JSON.parse(
      (await worker.evaluate(
        `(async () => {
           const manifest = chrome.runtime.getManifest();
           const popup = await chrome.action.getPopup({});
           return JSON.stringify({
             name: manifest.name,
             version: manifest.version,
             mv: manifest.manifest_version,
             hasSidePanelApi: typeof chrome.sidePanel?.open === "function",
             popupEntry: popup,
             browserRef: typeof browser
           });
         })()`
      )) || "{}"
    );

    console.log("\n清单与后台脚本");
    assert(manifestProbe.name === EXPECTED_NAME, `扩展名称正确：${manifestProbe.name}`);
    assert(manifestProbe.mv === 3, "manifest_version = 3");
    assert(manifestProbe.hasSidePanelApi === true, "chrome.sidePanel.open 可用（侧边栏入口）");
    assert(
      String(manifestProbe.popupEntry || "").endsWith("sidebar.html?mode=popup"),
      `工具栏弹窗入口被 Chromium 原样接受（含查询串）：${manifestProbe.popupEntry}`
    );
    // 部分 Edge/Chromium 版本会额外暴露 browser 别名；无论是否存在，代码都只走 chrome.*
    console.log(
      manifestProbe.browserRef === "undefined"
        ? "  · 该 Edge 版本未定义 browser 全局 → 兼容垫片是本扩展可运行的前提"
        : `  · 该 Edge 版本额外暴露了 browser 别名（${manifestProbe.browserRef}），代码仍统一走 chrome.*`
    );

    console.log("\n权限 API 可用性");
    const apiProbe = JSON.parse(
      (await worker.evaluate(
        `JSON.stringify({
           storage: typeof chrome.storage?.local?.get,
           cookies: typeof chrome.cookies?.getAll,
           tabs: typeof chrome.tabs?.query,
           action: typeof chrome.action?.setPopup,
           dnr: typeof chrome.declarativeNetRequest?.updateDynamicRules
         })`
      )) || "{}"
    );
    assert(apiProbe.storage === "function", "chrome.storage.local.get");
    assert(apiProbe.cookies === "function", "chrome.cookies.getAll");
    assert(apiProbe.tabs === "function", "chrome.tabs.query");
    assert(apiProbe.action === "function", "chrome.action");
    assert(apiProbe.dnr === "function", "chrome.declarativeNetRequest.updateDynamicRules");

    console.log("\nDNR 动态规则读写（Cookie 注入链路）");
    const dnrProbe = JSON.parse(
      (await worker.evaluate(
        `(async () => {
           const base = await chrome.declarativeNetRequest.getDynamicRules();
           await chrome.declarativeNetRequest.updateDynamicRules({
             removeRuleIds: base.map((r) => r.id),
             addRules: [{
               id: 10000,
               priority: 1,
               action: { type: "modifyHeaders", requestHeaders: [{ header: "Cookie", operation: "set", value: "game_token=smoke" }] },
               condition: { regexFilter: ".*api\\\\.blablalink\\\\.com.*[?&]_acct_id=123(?:&|$)", resourceTypes: ["xmlhttprequest"] }
             }]
           });
           const after = await chrome.declarativeNetRequest.getDynamicRules();
           await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: after.map((r) => r.id), addRules: [] });
           const cleaned = await chrome.declarativeNetRequest.getDynamicRules();
           return JSON.stringify({ added: after.length, cleaned: cleaned.length });
         })()`
      )) || "{}"
    );
    assert(dnrProbe.added === 1, "modifyHeaders 动态规则写入成功");
    assert(dnrProbe.cleaned === 0, "动态规则清理成功");

    console.log("\n扩展页面");
    const pageTarget = (await listTargets()).find(
      (target) => target.type === "page" && /^about:blank/.test(target.url || "")
    );
    assert(Boolean(pageTarget), "找到用于导航的空白页面目标");

    pageSession = await CdpSession.open(pageTarget.webSocketDebuggerUrl);
    await pageSession.send("Runtime.enable");
    await pageSession.send("Log.enable");
    await pageSession.send("Page.enable");

    const popup = await inspectExtensionPage(
      pageSession,
      `chrome-extension://${extensionId}/sidebar.html?mode=popup`,
      `JSON.stringify({
         mode: document.documentElement.dataset.mode,
         title: document.title,
         hasSyncButton: Boolean(document.getElementById("btnSync")),
         hasLogBox: Boolean(document.getElementById("syncLogBox")),
         hasTheme: typeof window.ThemeCtl,
         browserRef: typeof browser
       })`
    );
    assert(popup.ready, "弹窗页 (sidebar.html?mode=popup) 脚本加载完成");
    assert(popup.probe.mode === "popup", "按 popup 模式渲染（380px 布局、迷你宽度）");
    assert(popup.probe.hasSyncButton && popup.probe.hasLogBox, "同步按钮与日志面板均已渲染");
    assert(popup.probe.hasTheme === "object", "主题控制器 theme.js 正常挂载");
    console.log(
      popup.probe.browserRef === "undefined"
        ? "  · 页面内无 browser 全局，仍正常初始化（兼容垫片生效）"
        : "  · 页面内存在 browser 别名，代码依然只使用 chrome.*"
    );

    const sidepanel = await inspectExtensionPage(
      pageSession,
      `chrome-extension://${extensionId}/sidebar.html`,
      `JSON.stringify({ mode: document.documentElement.dataset.mode, hasSyncButton: Boolean(document.getElementById("btnSync")) })`
    );
    assert(sidepanel.ready, "侧边栏页 (sidebar.html) 脚本加载完成");
    assert(sidepanel.probe.mode === "sidebar", "无查询串时按 sidebar 模式渲染（100% 宽度）");

    const calculator = await inspectExtensionPage(
      pageSession,
      `chrome-extension://${extensionId}/calculator.html`,
      `JSON.stringify({
         engineLoaded: typeof window.NIKKE_ENGINE,
         slotCards: document.querySelectorAll("#slotArea .slot, #slotArea > *").length,
         presetButtons: document.querySelectorAll("#presetArea button").length,
         hasImportCard: Boolean(document.getElementById("importCard")),
         hasResult: Boolean(document.getElementById("resultArea")),
         title: document.title
       })`
    );
    assert(calculator.ready, "计算器完整页 (calculator.html) 脚本加载完成");
    assert(calculator.probe.engineLoaded === "object", "计算引擎 window.NIKKE_ENGINE 已加载");
    assert(calculator.probe.hasImportCard && calculator.probe.hasResult, "导入卡片与结果区已渲染");
    assert(calculator.probe.presetButtons > 0, `预设按钮已生成（${calculator.probe.presetButtons} 个）`);

    const pageErrors = [...popup.errors, ...sidepanel.errors, ...calculator.errors];
    assert(pageErrors.length === 0, `三个页面均无 JS 异常${pageErrors.length ? `：${pageErrors.join(" | ")}` : ""}`);

    console.log("\n端到端集成（真实 chrome.* 回调 API → 兼容垫片）");
    const backToPanel = await inspectExtensionPage(
      pageSession,
      `chrome-extension://${extensionId}/sidebar.html`,
      `JSON.stringify({ mode: document.documentElement.dataset.mode })`
    );
    assert(backToPanel.ready, "回到同步面板以执行集成检查");

    const integration = JSON.parse(
      (await pageSession.evaluate(
        `(async () => {
           const api = await import(chrome.runtime.getURL("blablalink-api.js"));
           await api.storageSet({ smokeKey: 42 });
           const stored = await api.storageGet("smokeKey");
           const cookies = await api.getBlablalinkBrowserCookies();
           const hostPermission = await api.hasBlablalinkHostPermission();
           const reg = await chrome.runtime.sendMessage({
             type: "REGISTER_COOKIE_RULE",
             payload: { gameUid: "999", cookie: "game_token=smoke" }
           });
           const rules = await chrome.declarativeNetRequest.getDynamicRules();
           const unreg = await chrome.runtime.sendMessage({ type: "UNREGISTER_COOKIE_RULES" });
           const cleaned = await chrome.declarativeNetRequest.getDynamicRules();
           const openTab = await chrome.runtime.sendMessage({ type: "OPEN_CALCULATOR_TAB" });
           return JSON.stringify({
             roundTrip: stored?.smokeKey ?? null,
             cookieCount: Array.isArray(cookies) ? cookies.length : -1,
             hostPermission,
             ruleRegistered: Boolean(reg?.ok),
             ruleCount: rules.length,
             unregistered: Boolean(unreg?.ok),
             cleanedCount: cleaned.length,
             openTabOk: Boolean(openTab?.ok)
           });
         })()`
      )) || "{}"
    );
    assert(integration.roundTrip === 42, "storage.set/get 经垫片完成跨上下文往返（回调式 API 已 Promise 化）");
    assert(integration.cookieCount >= 0, "cookies.getAll 经垫片返回数组（无登录态时为空）");
    assert(integration.hostPermission === true, "permissions.contains 判定 blablalink.com 主机权限已授予");
    assert(integration.ruleRegistered === true, "页面 → Service Worker 注册 DNR 规则成功");
    assert(integration.ruleCount === 1, "动态规则已写入（1 条 modifyHeaders）");
    assert(integration.unregistered === true && integration.cleanedCount === 0, "动态规则可正常注销");
    assert(integration.openTabOk === true, "页面 → Service Worker 打开/聚焦计算器标签页成功");

    // 点击「保存 / 更新 Cookie」：完整走 cookies + storage + DNR 注册链路（无登录态应提示未登录）
    await pageSession.evaluate(`document.getElementById("btnSaveCookie").click(), true`);
    let toastText = "";
    for (let i = 0; i < 20; i += 1) {
      await sleep(200);
      toastText = String(
        (await pageSession.evaluate(
          `document.getElementById("toastBar")?.hidden ? "" : document.getElementById("toastBar")?.textContent || ""`
        )) || ""
      );
      if (toastText) break;
    }
    assert(
      toastText.includes("未登录"),
      `「保存 Cookie」按钮给出未登录提示（toast: ${toastText || "无"}）`
    );

    console.log("\n全部冒烟检查通过 ✅");
  } finally {
    pageSession?.close();
    browser?.close();
    child.kill();
    await sleep(800);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 无头进程可能尚未完全退出，忽略
    }
  }
}

main().catch((error) => {
  console.error(`\n冒烟测试失败：${error.message}`);
  process.exitCode = 1;
});
