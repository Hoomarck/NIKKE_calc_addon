// SPDX-License-Identifier: GPL-3.0-or-later
// 侧边栏与弹窗共用控制脚本

import {
  STORAGE_KEYS,
  deriveBlablalinkLoginState,
  formatCircuitReason,
  getBlablalinkBrowserCookies,
  getSyncCircuitState,
  getSyncCooldownState,
  hasBlablalinkHostPermission,
  openBlablalinkLoginTab,
  parseManualAreaId,
  requestBlablalinkHostPermission,
  saveCurrentBrowserCookie,
  storageGet,
  storageSet,
  subscribePermissionChanges,
  syncAccountEquipments,
} from "./blablalink-api.js";
import { callApi, detectPopupContext, ext, openSidePanel, sendMessageSafe } from "./extension-api.js";

const MAX_LOG_LINES = 200;

const params = new URLSearchParams(window.location.search);
const explicitMode = params.get("mode");
let mode = explicitMode === "popup" || explicitMode === "sidebar" ? explicitMode : "sidebar";
document.documentElement.dataset.mode = mode;

// 清单入口若丢失 "?mode=popup" 查询串，仍按 action 弹窗（380px）渲染
void (async () => {
  if (explicitMode === "popup" || explicitMode === "sidebar") return;
  if ((await detectPopupContext(ext)) !== "popup") return;
  mode = "popup";
  document.documentElement.dataset.mode = mode;
})();

const $ = (id) => document.getElementById(id);

const ui = {
  btnOpenSidebar: $("btnOpenSidebar"),
  btnOpenCalc: $("btnOpenCalc"),
  permBanner: $("permBanner"),
  btnGrantPerm: $("btnGrantPerm"),
  toastBar: $("toastBar"),
  loginStatusBadge: $("loginStatusBadge"),
  loginDetail: $("loginDetail"),
  btnOpenLogin: $("btnOpenLogin"),
  btnSaveCookie: $("btnSaveCookie"),
  serverSelect: $("serverSelect"),
  manualAreaInput: $("manualAreaInput"),
  manualAreaError: $("manualAreaError"),
  btnSync: $("btnSync"),
  syncSummarySub: $("syncSummarySub"),
  syncGuardHint: $("syncGuardHint"),
  btnCopyLog: $("btnCopyLog"),
  btnClearLog: $("btnClearLog"),
  syncLogBox: $("syncLogBox"),
};

let syncing = false;
let savingCookie = false;
let toastTimer = null;
let guardTimer = null;
let cookieRefreshTimer = null;
let currentLogs = [];

function showToast(message, level = "ok") {
  if (!ui.toastBar) return;
  clearTimeout(toastTimer);
  ui.toastBar.textContent = message;
  ui.toastBar.className = `sb-toast ${level}`;
  ui.toastBar.hidden = false;
  toastTimer = setTimeout(() => {
    ui.toastBar.hidden = true;
  }, 4500);
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "";
  }
}

function renderLogs() {
  if (!ui.syncLogBox) return;
  if (!currentLogs.length) {
    ui.syncLogBox.textContent = "暂无日志。点击上方「一键同步角色与装备数据」开始获取。";
    return;
  }
  ui.syncLogBox.textContent = currentLogs.join("\n");
  ui.syncLogBox.scrollTop = ui.syncLogBox.scrollHeight;
}

async function appendLog(message) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  currentLogs = [...currentLogs, `[${stamp}] ${message}`].slice(-MAX_LOG_LINES);
  renderLogs();
  await storageSet({ [STORAGE_KEYS.SYNC_LOG]: currentLogs }, ext).catch(() => undefined);
}

async function clearLogs() {
  currentLogs = [];
  renderLogs();
  await storageSet({ [STORAGE_KEYS.SYNC_LOG]: [] }, ext).catch(() => undefined);
}

async function refreshPermissionBanner() {
  const granted = await hasBlablalinkHostPermission(ext).catch(() => true);
  ui.permBanner.hidden = granted;
  return granted;
}

async function refreshLoginAndSummary() {
  const [cookies, data] = await Promise.all([
    getBlablalinkBrowserCookies(ext).catch(() => []),
    storageGet([STORAGE_KEYS.ACCOUNT, STORAGE_KEYS.SNAPSHOT], ext),
  ]);

  const savedAccount = data?.[STORAGE_KEYS.ACCOUNT] || null;
  const snapshot = data?.[STORAGE_KEYS.SNAPSHOT] || null;
  const state = deriveBlablalinkLoginState(cookies, savedAccount);

  if (!state.loggedIn) {
    ui.loginStatusBadge.textContent = "未登录";
    ui.loginStatusBadge.className = "status-pill no";
    ui.loginDetail.innerHTML = "未检测到 <code>blablalink.com</code> 的登录 Cookie。请先打开官网完成登录，再回来点击同步。";
  } else {
    ui.loginStatusBadge.textContent = "已登录";
    ui.loginStatusBadge.className = "status-pill ok";
    const lines = [];
    const nameTxt = state.roleName ? `<b>${escapeHtml(state.roleName)}</b>` : "已取得登录凭据";
    const areaTxt = state.areaId ? ` · 区服 area_id: <code>${escapeHtml(state.areaId)}</code>` : "";
    lines.push(`<div>${nameTxt}${areaTxt}</div>`);
    if (state.source === "saved") {
      lines.push("<div>来源：已保存的本地 Cookie</div>");
    }
    if (snapshot?.updatedAt) {
      lines.push(
        `<div>已同步：<b>${snapshot.characterCount || 0}</b> 名妮姬（<b>${snapshot.withAffixCount || 0}</b> 名含洗练词条） · ${escapeHtml(formatTime(snapshot.updatedAt))}</div>`
      );
    } else {
      lines.push("<div>尚未同步角色装备数据，请点击下方「一键同步」。</div>");
    }
    ui.loginDetail.innerHTML = lines.join("");
  }

  if (snapshot?.updatedAt) {
    ui.syncSummarySub.textContent = `${snapshot.characterCount || 0} 名角色 · ${formatTime(snapshot.updatedAt)}`;
  } else {
    ui.syncSummarySub.textContent = "未同步";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

async function refreshSyncGuard() {
  clearTimeout(guardTimer);
  if (syncing) {
    ui.btnSync.disabled = true;
    ui.btnSync.innerHTML = '<span class="spin"></span> 正在同步角色与装备…';
    ui.syncGuardHint.hidden = true;
    return;
  }

  const [cooldown, circuit] = await Promise.all([
    getSyncCooldownState(ext).catch(() => ({ allowed: true, waitMs: 0, reason: "" })),
    getSyncCircuitState(ext).catch(() => null),
  ]);

  const circuitMsg = circuit ? formatCircuitReason(circuit) : "";
  if (circuitMsg) {
    ui.btnSync.disabled = true;
    ui.btnSync.textContent = "同步保护中（请稍候）";
    ui.syncGuardHint.textContent = circuitMsg;
    ui.syncGuardHint.hidden = false;
    guardTimer = setTimeout(refreshSyncGuard, 1000);
    return;
  }

  if (!cooldown.allowed && cooldown.waitMs > 0) {
    const secs = Math.max(1, Math.ceil(cooldown.waitMs / 1000));
    ui.btnSync.disabled = true;
    ui.btnSync.textContent = `冷却中 (${secs}s 后可同步)`;
    ui.syncGuardHint.textContent = cooldown.reason;
    ui.syncGuardHint.hidden = false;
    guardTimer = setTimeout(refreshSyncGuard, 1000);
    return;
  }

  ui.btnSync.disabled = false;
  ui.btnSync.textContent = "🔄 一键同步角色与装备数据";
  ui.syncGuardHint.hidden = true;
}

async function loadInitialState() {
  const data = await storageGet([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SYNC_LOG], ext);
  const settings = data?.[STORAGE_KEYS.SETTINGS] || {};
  if (settings.server === "hmt" || settings.server === "global") {
    ui.serverSelect.value = settings.server;
  }
  if (settings.manualAreaId) {
    ui.manualAreaInput.value = String(settings.manualAreaId);
  }
  if (Array.isArray(data?.[STORAGE_KEYS.SYNC_LOG])) {
    currentLogs = data[STORAGE_KEYS.SYNC_LOG].slice(-MAX_LOG_LINES);
  }
  renderLogs();

  await Promise.all([
    refreshPermissionBanner(),
    refreshLoginAndSummary(),
    refreshSyncGuard(),
  ]);
}

function bindEvents() {
  // Chromium 要求 sidePanel.open() 必须在用户手势内同步调用，禁止在之前 await
  ui.btnOpenSidebar?.addEventListener("click", () => {
    if (openSidePanel(ext)) {
      if (mode === "popup") window.close();
      return;
    }
    // 降级：不支持侧边栏 API 的浏览器版本，以独立标签页打开同一面板
    if (typeof ext?.tabs?.create === "function" && ext?.runtime?.getURL) {
      void callApi(ext.tabs, "create", {
        url: ext.runtime.getURL("sidebar.html?mode=sidebar"),
        active: true,
      }).catch(() => undefined);
      if (mode === "popup") window.close();
      return;
    }
    showToast("当前浏览器不支持侧边栏，请直接使用工具栏弹窗面板", "warn");
  });

  ui.btnOpenCalc?.addEventListener("click", async () => {
    const res = await sendMessageSafe({ type: "OPEN_CALCULATOR_TAB" }, ext);
    if (!res?.ok && typeof ext?.tabs?.create === "function" && ext?.runtime?.getURL) {
      await callApi(ext.tabs, "create", {
        url: ext.runtime.getURL("calculator.html"),
        active: true,
      }).catch(() => undefined);
    }
    if (mode === "popup") window.close();
  });

  ui.btnGrantPerm?.addEventListener("click", async () => {
    try {
      const granted = await requestBlablalinkHostPermission(ext);
      await refreshPermissionBanner();
      if (granted) {
        showToast("已授予 blablalink.com 访问权限", "ok");
        await refreshLoginAndSummary();
      } else {
        showToast("未授予访问权限，无法读取官网 Cookie 与同步数据", "warn");
      }
    } catch (err) {
      showToast(`权限请求失败: ${err?.message || err}`, "err");
    }
  });

  ui.btnOpenLogin?.addEventListener("click", async () => {
    try {
      await openBlablalinkLoginTab(ext);
      showToast("已打开 Blablalink 登录页，登录后返回即可同步", "ok");
    } catch (err) {
      showToast(`打开登录页失败: ${err?.message || err}`, "err");
    }
  });

  ui.btnSaveCookie?.addEventListener("click", async () => {
    if (savingCookie) return;
    savingCookie = true;
    ui.btnSaveCookie.disabled = true;
    ui.btnSaveCookie.innerHTML = '<span class="spin"></span> 保存中…';
    try {
      const res = await saveCurrentBrowserCookie({
        extApi: ext,
        onLog: (msg) => { void appendLog(msg); },
      });
      if (!res.success) {
        await appendLog(`⚠ ${res.error}`);
        showToast(res.error || "请先登录 Blablalink", "warn");
      } else {
        const who = res.account?.roleName ? `（${res.account.roleName}）` : "";
        const msg = `${res.updated ? "已更新" : "已保存"}本地 Cookie${who}`;
        await appendLog(`✓ ${msg}`);
        showToast(msg, "ok");
      }
      await refreshLoginAndSummary();
    } catch (err) {
      await appendLog(`✗ 保存 Cookie 异常: ${err?.message || err}`);
      showToast(`保存失败: ${err?.message || err}`, "err");
    } finally {
      savingCookie = false;
      ui.btnSaveCookie.disabled = false;
      ui.btnSaveCookie.textContent = "保存 / 更新 Cookie";
    }
  });

  ui.serverSelect?.addEventListener("change", async () => {
    const existing = (await storageGet(STORAGE_KEYS.SETTINGS, ext))?.[STORAGE_KEYS.SETTINGS] || {};
    await storageSet({
      [STORAGE_KEYS.SETTINGS]: { ...existing, server: ui.serverSelect.value },
    }, ext);
  });

  ui.manualAreaInput?.addEventListener("input", () => {
    const parsed = parseManualAreaId(ui.manualAreaInput.value);
    ui.manualAreaInput.classList.toggle("bad", !parsed.valid);
    ui.manualAreaError.hidden = parsed.valid;
  });

  ui.manualAreaInput?.addEventListener("change", async () => {
    const parsed = parseManualAreaId(ui.manualAreaInput.value);
    if (!parsed.valid) return;
    const existing = (await storageGet(STORAGE_KEYS.SETTINGS, ext))?.[STORAGE_KEYS.SETTINGS] || {};
    await storageSet({
      [STORAGE_KEYS.SETTINGS]: { ...existing, manualAreaId: parsed.value },
    }, ext);
  });

  ui.btnSync?.addEventListener("click", async () => {
    if (syncing) return;
    const parsed = parseManualAreaId(ui.manualAreaInput.value);
    if (!parsed.valid) {
      ui.manualAreaInput.classList.add("bad");
      ui.manualAreaError.hidden = false;
      showToast("手动 area_id 格式无效，请输入正整数或留空", "warn");
      return;
    }

    const permGranted = await refreshPermissionBanner();
    if (!permGranted) {
      showToast("请先点击「授予权限」允许访问 blablalink.com", "warn");
      return;
    }

    syncing = true;
    await refreshSyncGuard();

    try {
      const result = await syncAccountEquipments({
        server: ui.serverSelect.value,
        manualAreaId: ui.manualAreaInput.value,
        extApi: ext,
        onLog: (msg) => { void appendLog(msg); },
      });

      if (result.ok) {
        showToast(
          `同步成功：共 ${result.snapshot.characterCount} 名妮姬（${result.snapshot.withAffixCount} 名含词条）`,
          "ok"
        );
      } else {
        showToast(result.error || "同步失败", result.blocked ? "warn" : "err");
      }
      await refreshLoginAndSummary();
    } finally {
      syncing = false;
      await refreshSyncGuard();
    }
  });

  ui.btnCopyLog?.addEventListener("click", async () => {
    if (!currentLogs.length) {
      showToast("暂无日志可复制", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(currentLogs.join("\n"));
      showToast("已复制同步日志", "ok");
    } catch {
      showToast("复制失败，请手动选中复制", "err");
    }
  });

  ui.btnClearLog?.addEventListener("click", async () => {
    await clearLogs();
    showToast("已清空日志", "ok");
  });

  const scheduleCookieRefresh = () => {
    clearTimeout(cookieRefreshTimer);
    cookieRefreshTimer = setTimeout(() => {
      void refreshLoginAndSummary();
    }, 300);
  };

  ext?.cookies?.onChanged?.addListener?.((changeInfo) => {
    const cookie = changeInfo?.cookie;
    if (
      String(cookie?.domain || "").toLowerCase().endsWith("blablalink.com")
      && ["game_token", "game_uid", "game_openid"].includes(cookie?.name)
    ) {
      scheduleCookieRefresh();
    }
  });

  subscribePermissionChanges(() => {
    void refreshPermissionBanner();
  }, ext);

  ext?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[STORAGE_KEYS.SNAPSHOT] || changes[STORAGE_KEYS.ACCOUNT]) {
      void refreshLoginAndSummary();
    }
    if (changes[STORAGE_KEYS.SYNC_META] || changes[STORAGE_KEYS.CIRCUIT]) {
      void refreshSyncGuard();
    }
    if (changes[STORAGE_KEYS.SYNC_LOG] && Array.isArray(changes[STORAGE_KEYS.SYNC_LOG].newValue)) {
      currentLogs = changes[STORAGE_KEYS.SYNC_LOG].newValue.slice(-MAX_LOG_LINES);
      renderLogs();
    }
  });
}

bindEvents();
void loadInitialState();
