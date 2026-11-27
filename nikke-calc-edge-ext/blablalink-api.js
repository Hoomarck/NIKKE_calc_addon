// SPDX-License-Identifier: GPL-3.0-or-later
// BlaBlaLink 登录态检查、区域探测、角色装备抓取与计算器数据结构映射模块

import { resolveNikkeNameCn } from "./t2s.js";
import { callApi, ext as extensionNamespace, sendMessageSafe } from "./extension-api.js";

// Edge / Chromium 下只有 chrome.*，Firefox 下为 browser.*；统一由兼容垫片解析
const defaultExt = () => extensionNamespace;
const defaultFetch = (...args) => globalThis.fetch(...args);
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

export const REQUIRED_HOST_ORIGINS = Object.freeze(["*://*.blablalink.com/*"]);
export const BLABLALINK_LOGIN_URL = "https://www.blablalink.com/login";

export const USER_GAME_PLAYER_INFO_URL =
  "https://api.blablalink.com/api/ugc/direct/standalonesite/User/GetUserGamePlayerInfo";
export const USER_CHECK_LOGIN_URL =
  "https://api.blablalink.com/api/user/CheckLogin";
export const USER_INFO_NEW_URL =
  "https://api.blablalink.com/api/ugc/proxy/standalonesite/User/GetUserInfoNew";
export const USER_PRIVACY_SETTING_URL =
  "https://api.blablalink.com/api/ugc/direct/standalonesite/User/GetUserPrivacySetting";
export const USER_PROFILE_BASIC_INFO_URL =
  "https://api.blablalink.com/api/game/proxy/Game/GetUserProfileBasicInfo";
export const USER_CHARACTERS_URL =
  "https://api.blablalink.com/api/game/proxy/Game/GetUserCharacters";
export const USER_CHARACTER_DETAILS_URL =
  "https://api.blablalink.com/api/game/proxy/Game/GetUserCharacterDetails";

export const NIKKE_TW_URL =
  "https://sg-tools-cdn.blablalink.com/jz-26/ww-14/c4619ec83335bcfd7b23e43600520dc7.json";
export const NIKKE_EN_URL =
  "https://sg-tools-cdn.blablalink.com/yl-57/hd-03/1bf030193826e243c2e195f951a4be00.json";

export const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SYNC_COOLDOWN_MS = 60_000;
export const FAILED_SYNC_COOLDOWN_MS = 10_000;
export const EMPTY_SYNC_RETRY_DELAY_MS = 2500;
export const PLAYER_INFO_SYSTEM_ERROR_CODE = "1300015";
export const PLAYER_INFO_RETRY_DELAYS_MS = Object.freeze([1000, 2000]);

export const SYNC_CIRCUIT_DURATIONS_MS = Object.freeze({
  rateLimit: 30 * 60_000,
  forbidden: 60 * 60_000,
  emptyData: 15 * 60_000,
  transient: 10 * 60_000,
});

const TRANSIENT_FAILURE_THRESHOLD = 2;
const HALF_OPEN_LEASE_MS = 5 * 60_000;

export const STORAGE_KEYS = Object.freeze({
  ACCOUNT: "nikkeCalcAccount",
  SETTINGS: "nikkeCalcSettings",
  DIRECTORY: "nikkeCalcDirectory",
  SNAPSHOT: "nikkeCalcSnapshot",
  PART_MEMORY: "nikkeCalcPartMemory",
  UI_PREFS: "nikkeCalcUiPrefs",
  SYNC_LOG: "nikkeCalcSyncLog",
  SYNC_META: "nikkeCalcSyncMeta",
  CIRCUIT: "syncCircuitBreakerV1",
});

export const EQUIP_PARTS = Object.freeze([
  Object.freeze({ index: 0, key: "head", name: "头部", shortName: "头" }),
  Object.freeze({ index: 1, key: "torso", name: "身躯", shortName: "身" }),
  Object.freeze({ index: 2, key: "arm", name: "臂部", shortName: "臂" }),
  Object.freeze({ index: 3, key: "leg", name: "腿部", shortName: "腿" }),
]);

export const FUNCTION_TYPE_TO_CALC_ID = Object.freeze({
  IncElementDmg: "elite",
  StatAccuracyCircle: "hit",
  StatAmmoLoad: "ammo",
  StatAtk: "atk",
  StatChargeDamage: "chg",
  StatChargeTime: "spd",
  StatCriticalDamage: "cdmg",
  StatCritical: "crit",
  StatDef: "def",
});

export const SUMMARY_TYPE_ORDER = Object.freeze([
  "elite",
  "atk",
  "ammo",
  "crit",
  "cdmg",
  "spd",
  "chg",
  "hit",
  "def",
]);

const COMMON_TIER_VALUES = Object.freeze([
  4.77, 5.47, 6.18, 6.88, 7.59, 8.29, 8.99, 9.70, 10.40, 11.11, 11.81, 12.51, 13.22, 13.92, 14.63,
]);

export const CALC_TYPE_DEFS = Object.freeze([
  Object.freeze({
    id: "elite",
    name: "优越代码伤害",
    abbr: "优",
    values: Object.freeze([9.54, 10.94, 12.34, 13.75, 15.15, 16.55, 17.95, 19.35, 20.75, 22.15, 23.56, 24.96, 26.36, 27.76, 29.16]),
  }),
  Object.freeze({
    id: "hit",
    name: "命中率",
    abbr: "命",
    values: COMMON_TIER_VALUES,
  }),
  Object.freeze({
    id: "ammo",
    name: "最大装弹数",
    abbr: "弹",
    values: Object.freeze([27.84, 31.93, 36.05, 40.16, 44.28, 48.39, 52.50, 56.60, 60.71, 64.82, 68.93, 73.04, 77.15, 81.26, 85.37]),
  }),
  Object.freeze({
    id: "atk",
    name: "攻击力",
    abbr: "攻",
    values: COMMON_TIER_VALUES,
  }),
  Object.freeze({
    id: "chg",
    name: "蓄力伤害",
    abbr: "蓄",
    values: COMMON_TIER_VALUES,
  }),
  Object.freeze({
    id: "spd",
    name: "蓄力速度",
    abbr: "速",
    values: Object.freeze([1.98, 2.28, 2.57, 2.86, 3.16, 3.45, 3.75, 4.04, 4.33, 4.63, 4.92, 5.22, 5.51, 5.80, 6.09]),
  }),
  Object.freeze({
    id: "cdmg",
    name: "暴击伤害",
    abbr: "伤",
    values: Object.freeze([6.64, 7.62, 8.60, 9.58, 10.56, 11.54, 12.52, 13.50, 14.48, 15.46, 16.44, 17.42, 18.40, 19.38, 20.36]),
  }),
  Object.freeze({
    id: "crit",
    name: "暴击率",
    abbr: "率",
    values: Object.freeze([2.30, 2.64, 2.98, 3.32, 3.66, 4.00, 4.34, 4.68, 5.02, 5.34, 5.70, 6.04, 6.38, 6.72, 7.07]),
  }),
  Object.freeze({
    id: "def",
    name: "防御力",
    abbr: "防",
    values: COMMON_TIER_VALUES,
  }),
]);

export const CALC_TIER_VALUES = Object.freeze(
  Object.fromEntries(CALC_TYPE_DEFS.map((t) => [t.id, t.values]))
);

const KNOWN_AREA_ID_CANDIDATES = Object.freeze({
  hmt: Object.freeze(["91"]),
  global: Object.freeze(["84", "82"]),
});

/* =========================================================================
 * 存储 & 扩展 API 兼容封装
 * ========================================================================= */

export async function storageGet(keys, extApi = defaultExt()) {
  const local = extApi?.storage?.local;
  if (typeof local?.get !== "function") return {};
  try {
    return (await callApi(local, "get", keys)) || {};
  } catch {
    return {};
  }
}

export async function storageSet(items, extApi = defaultExt()) {
  const local = extApi?.storage?.local;
  if (typeof local?.set !== "function") return;
  await callApi(local, "set", items);
}

async function sendRuntimeMessage(message, extApi = defaultExt()) {
  return sendMessageSafe(message, extApi);
}

/* =========================================================================
 * 权限、Cookie 与登录态
 * ========================================================================= */

export async function hasBlablalinkHostPermission(extApi = defaultExt()) {
  const permissions = extApi?.permissions;
  if (typeof permissions?.contains !== "function") return true;
  const granted = await callApi(permissions, "contains", {
    origins: [...REQUIRED_HOST_ORIGINS],
  });
  return Boolean(granted);
}

export async function requestBlablalinkHostPermission(extApi = defaultExt()) {
  const permissions = extApi?.permissions;
  if (typeof permissions?.request !== "function") return true;
  const granted = await callApi(permissions, "request", {
    origins: [...REQUIRED_HOST_ORIGINS],
  });
  return Boolean(granted);
}

export function subscribePermissionChanges(listener, extApi = defaultExt()) {
  if (typeof listener !== "function") return () => {};
  const onAdded = extApi?.permissions?.onAdded;
  const onRemoved = extApi?.permissions?.onRemoved;
  onAdded?.addListener?.(listener);
  onRemoved?.addListener?.(listener);
  return () => {
    onAdded?.removeListener?.(listener);
    onRemoved?.removeListener?.(listener);
  };
}

export function parseCookieValue(cookieStr, name) {
  if (!cookieStr || !name) return "";
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(cookieStr).match(
    new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`)
  );
  return match ? match[1] : "";
}

export function serializeBrowserCookies(cookies) {
  const values = new Map();
  (Array.isArray(cookies) ? cookies : []).forEach((cookie) => {
    const name = String(cookie?.name || "").trim();
    if (!name) return;
    if (!values.has(name) || cookie?.path === "/") {
      values.set(name, String(cookie?.value ?? ""));
    }
  });
  return [...values.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

const isBlablalinkCookie = (cookie) =>
  String(cookie?.domain || "").toLowerCase().endsWith("blablalink.com");

export async function getBlablalinkBrowserCookies(extApi = defaultExt()) {
  const cookiesApi = extApi?.cookies;
  if (typeof cookiesApi?.getAll !== "function") return [];
  const cookies = await callApi(cookiesApi, "getAll", { domain: "blablalink.com" });
  return (Array.isArray(cookies) ? cookies : []).filter(isBlablalinkCookie);
}

export function deriveBlablalinkLoginState(cookies, savedAccount = null) {
  const relevant = (Array.isArray(cookies) ? cookies : []).filter(isBlablalinkCookie);
  const pickCookie = (name) => {
    const rootCookie = relevant.find((c) => c?.name === name && c?.path === "/");
    return String((rootCookie || relevant.find((c) => c?.name === name))?.value || "");
  };

  let gameToken = pickCookie("game_token");
  let gameUid = pickCookie("game_uid");
  let gameOpenId = pickCookie("game_openid");
  let source = "browser";

  if (!gameToken && savedAccount?.cookie) {
    const savedToken = parseCookieValue(savedAccount.cookie, "game_token");
    if (savedToken) {
      gameToken = savedToken;
      gameUid = gameUid || String(savedAccount.gameUid || parseCookieValue(savedAccount.cookie, "game_uid") || "");
      gameOpenId = gameOpenId || String(savedAccount.gameOpenId || parseCookieValue(savedAccount.cookie, "game_openid") || "");
      source = "saved";
    }
  }

  const loggedIn = Boolean(gameToken);
  const sameAccount = Boolean(
    savedAccount
    && (
      (gameUid && savedAccount.gameUid === gameUid)
      || (gameOpenId && savedAccount.gameOpenId === gameOpenId)
      || (gameToken && parseCookieValue(savedAccount.cookie, "game_token") === gameToken)
    )
  );

  return {
    loggedIn,
    source: loggedIn ? source : "none",
    gameToken,
    gameUid,
    gameOpenId,
    roleName: sameAccount ? String(savedAccount?.roleName || "") : "",
    areaId: sameAccount ? String(savedAccount?.areaId || "") : "",
  };
}

export async function openBlablalinkLoginTab(extApi = defaultExt()) {
  const tabsApi = extApi?.tabs;
  if (typeof tabsApi?.create !== "function") return null;
  return callApi(tabsApi, "create", {
    url: BLABLALINK_LOGIN_URL,
    active: true,
  });
}

/* =========================================================================
 * 区域 ID 与请求工具
 * ========================================================================= */

export function parseManualAreaId(value) {
  const input = String(value ?? "").trim();
  if (!input) {
    return { empty: true, valid: true, value: "" };
  }
  if (!/^\d+$/.test(input)) {
    return { empty: false, valid: false, value: "" };
  }
  const num = Number(input);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return { empty: false, valid: false, value: "" };
  }
  return { empty: false, valid: true, value: String(num) };
}

export function getAreaIdProbeCandidates(server) {
  const key = String(server || "global").trim().toLowerCase();
  return [...(KNOWN_AREA_ID_CANDIDATES[key] || KNOWN_AREA_ID_CANDIDATES.global)];
}

export class ApiRequestError extends Error {
  constructor(message, { status = 0, endpoint = "", retryAfterMs = 0, businessCode = "" } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.code = "API_REQUEST_FAILED";
    this.status = status;
    this.endpoint = endpoint;
    this.retryAfterMs = retryAfterMs;
    this.businessCode = businessCode;
  }
}

export class EmptySyncDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmptySyncDataError";
    this.code = "EMPTY_CRAWL_DATA";
  }
}

const getEndpointName = (url) => {
  const path = String(url || "").split("?")[0];
  return path.split("/").filter(Boolean).pop() || "unknown-endpoint";
};

const emitDiag = (onDiagnostic, msg) => {
  if (typeof onDiagnostic !== "function") return;
  try {
    onDiagnostic(msg);
  } catch {
    // 日志回调异常不阻断主流程
  }
};

const getApiBusinessCode = (response) =>
  response?.code ?? response?.retcode ?? response?.ret_code;

const isApiResponseSuccessful = (response) =>
  String(getApiBusinessCode(response)) === "0";

const isPlayerInfoResponseSuccessful = (response) =>
  isApiResponseSuccessful(response) && Boolean(response?.data?.area_id);

const getCanonicalIntlOpenId = (response) =>
  String(response?.data?.info?.intl_openid ?? response?.data?.intl_openid ?? "").trim();

const parseRetryAfterMs = (value, currentNow = Date.now()) => {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - currentNow) : 0;
};

export async function postBlablalinkJson(
  url,
  bodyObj = {},
  { accountId = "", useDnr = false, fetchImpl = defaultFetch, onDiagnostic } = {}
) {
  const endpoint = getEndpointName(url);
  let targetUrl = url;
  let credentials = "include";

  if (useDnr && accountId) {
    const sep = url.includes("?") ? "&" : "?";
    targetUrl = `${url}${sep}_acct_id=${encodeURIComponent(accountId)}`;
    credentials = "omit";
  }

  let res;
  try {
    res = await fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(bodyObj),
      credentials,
    });
  } catch (error) {
    emitDiag(onDiagnostic, `${endpoint} 网络异常: ${error?.message || error}`);
    throw error;
  }

  if (!res.ok) {
    throw new ApiRequestError(`${res.status} ${res.statusText || "HTTP Error"}`.trim(), {
      status: res.status,
      endpoint,
      retryAfterMs: parseRetryAfterMs(res.headers?.get?.("Retry-After")),
    });
  }

  const payload = await res.json();
  const businessCode = getApiBusinessCode(payload);
  emitDiag(onDiagnostic, `${endpoint} 响应 code=${businessCode ?? "none"}`);
  return payload;
}

export async function recoverPlayerInfoSystemError({
  gameOpenId = "",
  accountId = "",
  useDnr = false,
  fetchImpl = defaultFetch,
  wait = defaultWait,
  retryDelaysMs = PLAYER_INFO_RETRY_DELAYS_MS,
  onDiagnostic,
} = {}) {
  const reqOpts = { accountId, useDnr, fetchImpl, onDiagnostic };
  emitDiag(onDiagnostic, `检测到 ${PLAYER_INFO_SYSTEM_ERROR_CODE}，开始玩家信息恢复链路`);

  for (let i = 0; i < retryDelaysMs.length; i += 1) {
    const delayMs = retryDelaysMs[i];
    if (delayMs > 0) await wait(delayMs);

    let retryResp = null;
    try {
      retryResp = await postBlablalinkJson(USER_GAME_PLAYER_INFO_URL, {}, reqOpts);
    } catch (err) {
      emitDiag(onDiagnostic, `恢复重试 ${i + 1} 异常: ${err?.message || err}`);
    }

    if (isPlayerInfoResponseSuccessful(retryResp)) {
      emitDiag(onDiagnostic, `恢复重试 ${i + 1} 成功获取 area_id`);
      return { response: retryResp, source: `retry-${i + 1}` };
    }

    const code = getApiBusinessCode(retryResp);
    if (retryResp && String(code) !== PLAYER_INFO_SYSTEM_ERROR_CODE) {
      break;
    }
  }

  if (gameOpenId) {
    let openIdResp = null;
    try {
      openIdResp = await postBlablalinkJson(
        USER_GAME_PLAYER_INFO_URL,
        { intl_openid: gameOpenId },
        reqOpts
      );
    } catch (err) {
      emitDiag(onDiagnostic, `后备1(game_openid) 异常: ${err?.message || err}`);
    }
    if (isPlayerInfoResponseSuccessful(openIdResp)) {
      emitDiag(onDiagnostic, "后备1(game_openid) 成功获取 area_id");
      return { response: openIdResp, source: "game-openid-cookie" };
    }
  }

  try {
    await postBlablalinkJson(USER_CHECK_LOGIN_URL, {}, reqOpts);
  } catch (err) {
    emitDiag(onDiagnostic, `后备2(CheckLogin) 异常: ${err?.message || err}`);
  }

  let userInfoResp = null;
  try {
    userInfoResp = await postBlablalinkJson(USER_INFO_NEW_URL, {}, reqOpts);
  } catch (err) {
    emitDiag(onDiagnostic, `后备3(GetUserInfoNew) 异常: ${err?.message || err}`);
  }

  const canonicalIntlOpenId = getCanonicalIntlOpenId(userInfoResp);
  if (!canonicalIntlOpenId) {
    emitDiag(onDiagnostic, "恢复链路未取得正式 intl_openid");
    return null;
  }

  try {
    await postBlablalinkJson(
      USER_PRIVACY_SETTING_URL,
      { intl_openid: canonicalIntlOpenId },
      reqOpts
    );
  } catch (err) {
    emitDiag(onDiagnostic, `后备4(PrivacySetting) 异常: ${err?.message || err}`);
  }

  let canonicalPlayerResp = null;
  try {
    canonicalPlayerResp = await postBlablalinkJson(
      USER_GAME_PLAYER_INFO_URL,
      { intl_openid: canonicalIntlOpenId },
      reqOpts
    );
  } catch (err) {
    emitDiag(onDiagnostic, `后备5(GetUserGamePlayerInfo) 异常: ${err?.message || err}`);
  }

  if (isPlayerInfoResponseSuccessful(canonicalPlayerResp)) {
    emitDiag(onDiagnostic, "恢复链路通过正式 intl_openid 成功获取 area_id");
    return {
      response: canonicalPlayerResp,
      source: "canonical-intl-openid",
      canonicalIntlOpenId,
    };
  }

  return null;
}

export async function fetchRoleInfo({
  cookie = "",
  gameUid = "",
  gameOpenId = "",
  useDnr = false,
  fetchImpl = defaultFetch,
  wait = defaultWait,
  retryDelaysMs = PLAYER_INFO_RETRY_DELAYS_MS,
  onDiagnostic,
} = {}) {
  const resolvedUid = gameUid || parseCookieValue(cookie, "game_uid");
  const resolvedOpenId = gameOpenId || parseCookieValue(cookie, "game_openid");
  const reqOpts = { accountId: resolvedUid, useDnr, fetchImpl, onDiagnostic };

  let playerResp = null;
  let playerErr = null;
  try {
    playerResp = await postBlablalinkJson(USER_GAME_PLAYER_INFO_URL, {}, reqOpts);
  } catch (err) {
    playerErr = err;
    if (err?.status === 429 || err?.status === 403) {
      throw err;
    }
  }

  if (
    !playerErr
    && String(getApiBusinessCode(playerResp)) === PLAYER_INFO_SYSTEM_ERROR_CODE
  ) {
    const recovery = await recoverPlayerInfoSystemError({
      gameOpenId: resolvedOpenId,
      accountId: resolvedUid,
      useDnr,
      fetchImpl,
      wait,
      retryDelaysMs,
      onDiagnostic,
    });
    if (recovery?.response) {
      playerResp = recovery.response;
    }
  }

  const areaId = !playerErr && playerResp?.data?.area_id
    ? String(playerResp.data.area_id)
    : "";
  const oldName = !playerErr ? String(playerResp?.data?.role_name || "") : "";

  if (areaId) {
    let finalName = oldName;
    let finalAreaId = areaId;
    try {
      const payload = { nikke_area_id: parseInt(areaId, 10) };
      if (resolvedOpenId) payload.intl_open_id = resolvedOpenId;
      const basicResp = await postBlablalinkJson(
        USER_PROFILE_BASIC_INFO_URL,
        payload,
        reqOpts
      );
      const info = basicResp?.data?.basic_info || {};
      finalName = info.nickname || finalName;
      if (info.area_id) finalAreaId = String(info.area_id);
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) {
        throw err;
      }
      emitDiag(onDiagnostic, `GetUserProfileBasicInfo 回退旧昵称: ${err?.message || err}`);
    }
    return {
      roleName: finalName,
      areaId: finalAreaId,
      authenticated: true,
    };
  }

  let authenticated = false;
  try {
    const checkResp = await postBlablalinkJson(USER_CHECK_LOGIN_URL, {}, reqOpts);
    authenticated = isApiResponseSuccessful(checkResp);
  } catch (err) {
    emitDiag(onDiagnostic, `CheckLogin 验证异常: ${err?.message || err}`);
    throw err;
  }

  return {
    roleName: oldName,
    areaId: "",
    authenticated,
  };
}

/* =========================================================================
 * 角色目录、角色列表与装备详情抓取
 * ========================================================================= */

export async function fetchUserCharacters({
  areaId,
  intlOpenId = "",
  accountId = "",
  useDnr = false,
  fetchImpl = defaultFetch,
  onDiagnostic,
}) {
  const response = await postBlablalinkJson(
    USER_CHARACTERS_URL,
    {
      intl_open_id: intlOpenId,
      nikke_area_id: parseInt(areaId, 10),
    },
    { accountId, useDnr, fetchImpl, onDiagnostic }
  );

  const code = getApiBusinessCode(response);
  if (code !== undefined && String(code) !== "0" && !response?.data) {
    throw new ApiRequestError(
      response?.message || response?.msg || `GetUserCharacters 失败 (${code})`,
      { endpoint: "GetUserCharacters", businessCode: String(code) }
    );
  }

  const chars = response?.data?.characters;
  if (!Array.isArray(chars)) return [];
  return chars.map((char) => ({
    name_code: char.name_code,
    lv: Number.isFinite(char.lv) ? char.lv : 1,
    combat: char.combat || 0,
    core: Number.isFinite(char.core) ? char.core : 0,
    grade: Number.isFinite(char.grade) ? char.grade : 0,
    costume_id: char.costume_id || 0,
  }));
}

export async function fetchUserCharacterDetails({
  areaId,
  intlOpenId = "",
  nameCodes = [],
  accountId = "",
  useDnr = false,
  fetchImpl = defaultFetch,
  onDiagnostic,
}) {
  const uniqueCodes = Array.isArray(nameCodes)
    ? Array.from(new Set(nameCodes.filter((v) => v !== undefined && v !== null && v !== "")))
    : [];
  if (uniqueCodes.length === 0) {
    return { characterDetails: [], stateEffects: [] };
  }

  const response = await postBlablalinkJson(
    USER_CHARACTER_DETAILS_URL,
    {
      intl_open_id: intlOpenId,
      nikke_area_id: parseInt(areaId, 10),
      name_codes: uniqueCodes,
    },
    { accountId, useDnr, fetchImpl, onDiagnostic }
  );

  const code = getApiBusinessCode(response);
  if (code !== undefined && String(code) !== "0" && !response?.data) {
    throw new ApiRequestError(
      response?.message || response?.msg || `GetUserCharacterDetails 失败 (${code})`,
      { endpoint: "GetUserCharacterDetails", businessCode: String(code) }
    );
  }

  return {
    characterDetails: Array.isArray(response?.data?.character_details)
      ? response.data.character_details
      : [],
    stateEffects: Array.isArray(response?.data?.state_effects)
      ? response.data.state_effects
      : [],
  };
}

export async function discoverAreaIdByProbing({
  server = "global",
  intlOpenId = "",
  accountId = "",
  useDnr = false,
  fetchImpl = defaultFetch,
  onDiagnostic,
} = {}) {
  const candidates = getAreaIdProbeCandidates(server);
  const probed = [];

  for (const candidate of candidates) {
    try {
      const characters = await fetchUserCharacters({
        areaId: candidate,
        intlOpenId,
        accountId,
        useDnr,
        fetchImpl,
        onDiagnostic,
      });
      probed.push({ areaId: candidate, success: true, count: characters.length });
      emitDiag(onDiagnostic, `探测 area_id=${candidate}: 角色数=${characters.length}`);
      if (characters.length > 0) {
        return { areaId: candidate, characters, probed };
      }
    } catch (error) {
      probed.push({ areaId: candidate, success: false, count: 0, error: error?.message || String(error) });
      emitDiag(onDiagnostic, `探测 area_id=${candidate} 失败: ${error?.message || error}`);
    }
  }

  return { areaId: "", characters: [], probed };
}

export async function fetchAndCacheNikkeDirectory({
  extApi = defaultExt(),
  fetchImpl = defaultFetch,
  forceRefresh = false,
  now = defaultNow,
  onDiagnostic,
} = {}) {
  const cachedWrap = (await storageGet(STORAGE_KEYS.DIRECTORY, extApi))?.[STORAGE_KEYS.DIRECTORY];
  const cachedItems = Array.isArray(cachedWrap?.items) ? cachedWrap.items : [];
  const cachedAt = Number(cachedWrap?.updatedAt || 0);

  if (!forceRefresh && cachedItems.length > 0 && now() - cachedAt < DIRECTORY_CACHE_TTL_MS) {
    return cachedItems;
  }

  try {
    const [twResp, enResp] = await Promise.all([
      fetchImpl(NIKKE_TW_URL, { credentials: "omit" }),
      fetchImpl(NIKKE_EN_URL, { credentials: "omit" }),
    ]);
    if (!twResp.ok || !enResp.ok) {
      throw new Error(`目录下载失败 (${twResp.status}/${enResp.status})`);
    }
    const [twData, enData] = await Promise.all([twResp.json(), enResp.json()]);
    const enMap = new Map(
      (Array.isArray(enData) ? enData : []).map((entry) => [entry?.id, entry])
    );

    const items = [];
    for (const tw of Array.isArray(twData) ? twData : []) {
      const nameCode = String(tw?.name_code ?? "").trim();
      if (!nameCode) continue;
      const en = enMap.get(tw.id);
      const rawTwName = String(tw?.name_localkey?.name || "").trim();
      const nameCn = resolveNikkeNameCn(nameCode, rawTwName);
      items.push({
        id: tw.id,
        nameCode,
        nameCn,
        nameTw: rawTwName,
        nameEn: String(en?.name_localkey?.name || "").trim(),
        element: String(tw?.element_id?.element?.element || ""),
        burst: String(tw?.use_burst_skill || ""),
        corporation: String(tw?.corporation || ""),
      });
    }

    if (items.length > 0) {
      await storageSet(
        {
          [STORAGE_KEYS.DIRECTORY]: {
            updatedAt: now(),
            items,
          },
        },
        extApi
      );
      return items;
    }
  } catch (error) {
    emitDiag(onDiagnostic, `拉取远端妮姬目录失败，使用缓存回退: ${error?.message || error}`);
  }

  return cachedItems;
}

/* =========================================================================
 * 词条映射与四件装备汇总
 * ========================================================================= */

export function inferTierFromPercent(calcTypeId, percentVal, { tolerance = 0.5 } = {}) {
  const values = CALC_TIER_VALUES[calcTypeId];
  const target = Number(percentVal);
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(target)) {
    return 1;
  }

  let bestTier = 1;
  let bestDiff = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const diff = Math.abs(values[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTier = i + 1;
    }
  }
  return bestDiff <= tolerance ? bestTier : 1;
}

export function parseEquipmentSlotsFromApi(charDetail, partKey, effectsMap = {}) {
  const slots = [
    { type: null, tier: 1, locked: false },
    { type: null, tier: 1, locked: false },
    { type: null, tier: 1, locked: false },
  ];

  for (let position = 1; position <= 3; position += 1) {
    const optionId = charDetail?.[`${partKey}_equip_option${position}_id`];
    if (!optionId || optionId === 0) continue;

    const effect = effectsMap[String(optionId)] ?? effectsMap[optionId];
    const details = effect?.function_details;
    if (!Array.isArray(details) || details.length === 0) continue;

    const matchedFunc = details.find((func) =>
      Object.prototype.hasOwnProperty.call(FUNCTION_TYPE_TO_CALC_ID, func?.function_type)
    );
    if (!matchedFunc) continue;

    const calcTypeId = FUNCTION_TYPE_TO_CALC_ID[matchedFunc.function_type];
    const rawLevel = Number(matchedFunc.level);
    let tier;
    if (Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 15) {
      tier = rawLevel;
    } else {
      const percentVal = Math.abs(Number(matchedFunc.function_value || 0)) / 100;
      tier = inferTierFromPercent(calcTypeId, percentVal);
    }

    slots[position - 1] = {
      type: calcTypeId,
      tier,
      locked: false,
    };
  }

  return slots;
}

export function buildSyncedSnapshot({
  accountInfo = {},
  userCharacters = [],
  characterDetails = [],
  stateEffects = [],
  directoryItems = [],
  now = defaultNow(),
} = {}) {
  const effectsMap = {};
  (Array.isArray(stateEffects) ? stateEffects : []).forEach((effect) => {
    if (effect && effect.id !== undefined && effect.id !== null) {
      effectsMap[String(effect.id)] = effect;
    }
  });

  const directoryByCode = new Map();
  (Array.isArray(directoryItems) ? directoryItems : []).forEach((item) => {
    const code = String(item?.nameCode ?? item?.name_code ?? "").trim();
    if (code) directoryByCode.set(code, item);
  });

  const userCharByCode = new Map();
  (Array.isArray(userCharacters) ? userCharacters : []).forEach((uc) => {
    const code = String(uc?.name_code ?? "").trim();
    if (code) userCharByCode.set(code, uc);
  });

  const seenCodes = new Set();
  const characters = [];

  for (const detail of Array.isArray(characterDetails) ? characterDetails : []) {
    const nameCode = String(detail?.name_code ?? "").trim();
    if (!nameCode || seenCodes.has(nameCode)) continue;
    seenCodes.add(nameCode);

    const dirEntry = directoryByCode.get(nameCode);
    const userChar = userCharByCode.get(nameCode);
    const fallbackName = `妮姬 #${nameCode}`;
    const rawCn = dirEntry?.nameCn || dirEntry?.name_cn || dirEntry?.nameTw || "";
    const nameCn = rawCn ? resolveNikkeNameCn(nameCode, rawCn) : resolveNikkeNameCn(nameCode, fallbackName);

    let affixCount = 0;
    const equipments = EQUIP_PARTS.map((part) => {
      const slots = parseEquipmentSlotsFromApi(detail, part.key, effectsMap);
      affixCount += slots.filter((s) => Boolean(s.type)).length;
      return {
        partIndex: part.index,
        partKey: part.key,
        partName: part.name,
        partShortName: part.shortName,
        equipTid: detail?.[`${part.key}_equip_tid`] ?? null,
        equipLv: detail?.[`${part.key}_equip_lv`] ?? null,
        corporationType: detail?.[`${part.key}_equip_corporation_type`] ?? null,
        slots,
      };
    });

    characters.push({
      nameCode,
      nameCn,
      nameTw: String(dirEntry?.nameTw || ""),
      nameEn: String(dirEntry?.nameEn || dirEntry?.name_en || ""),
      element: String(dirEntry?.element || ""),
      burst: String(dirEntry?.burst || ""),
      corporation: String(dirEntry?.corporation || ""),
      lv: Number(detail?.lv || userChar?.lv || 1),
      combat: Number(detail?.combat || userChar?.combat || 0),
      affixCount,
      equipments,
    });
  }

  characters.sort((a, b) => (
    b.affixCount - a.affixCount
    || b.combat - a.combat
    || a.nameCn.localeCompare(b.nameCn, "zh-Hans-CN")
  ));

  return {
    version: 1,
    updatedAt: now,
    account: {
      roleName: String(accountInfo?.roleName || ""),
      areaId: String(accountInfo?.areaId || ""),
      gameUid: String(accountInfo?.gameUid || ""),
      server: String(accountInfo?.server || "global"),
    },
    ownedCount: Array.isArray(userCharacters) && userCharacters.length > 0
      ? userCharacters.length
      : characters.length,
    characterCount: characters.length,
    withAffixCount: characters.filter((c) => c.affixCount > 0).length,
    characters,
  };
}

/**
 * 汇总角色头/身/臂/腿四件装备的 12 个槽位词条
 * 使用整数基点 (Math.round(val * 100)) 累加，避免浮点误差
 */
export function summarizeCharacterEquipments(
  equipments,
  typeDefs = CALC_TYPE_DEFS,
  activePartIndex = -1
) {
  const defs = Array.isArray(typeDefs) && typeDefs.length > 0 ? typeDefs : CALC_TYPE_DEFS;
  const defMap = new Map(defs.map((d) => [d.id, d]));
  const stats = new Map();

  for (const id of SUMMARY_TYPE_ORDER) {
    const def = defMap.get(id) || CALC_TYPE_DEFS.find((t) => t.id === id);
    if (!def) continue;
    stats.set(id, {
      id: def.id,
      name: def.name,
      abbr: def.abbr,
      count: 0,
      totalBp: 0,
      partTiers: [null, null, null, null],
    });
  }

  const equipList = Array.isArray(equipments) ? equipments : [];
  for (let partIdx = 0; partIdx < 4; partIdx += 1) {
    const equip = equipList[partIdx];
    const slots = Array.isArray(equip) ? equip : equip?.slots;
    if (!Array.isArray(slots)) continue;

    for (let slotIdx = 0; slotIdx < 3; slotIdx += 1) {
      const slot = slots[slotIdx];
      const typeId = slot?.type;
      if (!typeId || !stats.has(typeId)) continue;

      const def = defMap.get(typeId);
      const maxTier = Array.isArray(def?.values) && def.values.length > 0 ? def.values.length : 15;
      const tier = Math.max(1, Math.min(maxTier, Math.trunc(Number(slot.tier) || 1)));
      const val = Number(def?.values?.[tier - 1] ?? CALC_TIER_VALUES[typeId]?.[tier - 1] ?? 0);
      const bp = Number.isFinite(val) ? Math.round(val * 100) : 0;

      const entry = stats.get(typeId);
      entry.count += 1;
      entry.totalBp += bp;
      entry.partTiers[partIdx] = entry.partTiers[partIdx] === null
        ? tier
        : Math.max(entry.partTiers[partIdx], tier);
    }
  }

  const items = SUMMARY_TYPE_ORDER.map((id) => {
    const entry = stats.get(id);
    const inActivePart =
      activePartIndex >= 0
      && activePartIndex < 4
      && entry.partTiers[activePartIndex] !== null;

    return {
      id: entry.id,
      name: entry.name,
      abbr: entry.abbr,
      count: entry.count,
      totalBp: entry.totalBp,
      totalVal: entry.totalBp / 100,
      partTiers: entry.partTiers,
      inActivePart,
    };
  });

  // 排序：命中的词条（count > 0）前置，未命中的（count === 0）排至末尾；
  // 两组内部均保持 SUMMARY_TYPE_ORDER 的原有相对顺序。
  return [
    ...items.filter((item) => item.count > 0),
    ...items.filter((item) => item.count === 0),
  ];
}

/* =========================================================================
 * 请求保护：冷却与熔断
 * ========================================================================= */

const emptyCircuitState = () => ({
  status: "closed",
  blockedUntil: 0,
  reason: "",
  consecutiveTransientFailures: 0,
  updatedAt: 0,
});

const normalizeCircuitState = (value) => ({
  ...emptyCircuitState(),
  ...(value && typeof value === "object" ? value : {}),
  blockedUntil: Number(value?.blockedUntil) || 0,
  consecutiveTransientFailures: Math.max(
    0,
    Number(value?.consecutiveTransientFailures) || 0
  ),
});

export function formatCircuitReason(state, currentNow = Date.now()) {
  const normalized = normalizeCircuitState(state);
  if (
    normalized.status === "half-open"
    && currentNow - normalized.updatedAt < HALF_OPEN_LEASE_MS
  ) {
    return "同步保护正在进行恢复测试，请稍后重试";
  }
  const waitMs = Math.max(0, normalized.blockedUntil - currentNow);
  if (normalized.status !== "open" || waitMs <= 0) return "";
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `同步保护已暂停请求：${normalized.reason || "服务异常"}，约 ${minutes} 分钟后可重试`;
}

export function classifySyncFailure(error) {
  if (!error) return { kind: "ignored", reason: "", retryAfterMs: 0 };
  const message = String(error?.message || error || "");
  const status = Number(error?.status || 0);
  const code = String(error?.code || "");
  const retryAfterMs = Number(error?.retryAfterMs) || 0;

  if (status === 429 || /\b429\b|too many requests|rate.?limit|请求过于频繁/i.test(message)) {
    return { kind: "rateLimit", reason: "服务端限流", retryAfterMs };
  }
  if (status === 403 || /\b403\b|forbidden/i.test(message)) {
    return { kind: "forbidden", reason: "服务端拒绝访问", retryAfterMs };
  }
  if (code === "EMPTY_CRAWL_DATA" || /持有角色列表为空|未返回任何角色详情|异常空数据/i.test(message)) {
    return { kind: "emptyData", reason: "连续取得异常空数据", retryAfterMs };
  }
  if (
    status >= 500
    || /\b5\d\d\b|timeout|timed out|network|fetch failed|网络异常|连接失败/i.test(message)
  ) {
    return { kind: "transient", reason: "连续网络或服务器异常", retryAfterMs };
  }
  return { kind: "ignored", reason: "", retryAfterMs: 0 };
}

export async function getSyncCircuitState(extApi = defaultExt()) {
  const data = await storageGet(STORAGE_KEYS.CIRCUIT, extApi);
  return normalizeCircuitState(data?.[STORAGE_KEYS.CIRCUIT]);
}

async function acquireSyncCircuitPermit({ extApi = defaultExt(), now = defaultNow } = {}) {
  const timestamp = now();
  const state = await getSyncCircuitState(extApi);

  if (state.status === "open" && state.blockedUntil > timestamp) {
    return {
      allowed: false,
      state,
      waitMs: state.blockedUntil - timestamp,
      reason: formatCircuitReason(state, timestamp),
    };
  }
  if (
    state.status === "half-open"
    && timestamp - state.updatedAt < HALF_OPEN_LEASE_MS
  ) {
    return {
      allowed: false,
      state,
      waitMs: 0,
      reason: "同步保护正在进行恢复测试，请稍后重试",
    };
  }
  if (state.status === "open" || state.status === "half-open") {
    const halfOpen = { ...state, status: "half-open", blockedUntil: 0, updatedAt: timestamp };
    await storageSet({ [STORAGE_KEYS.CIRCUIT]: halfOpen }, extApi);
    return { allowed: true, state: halfOpen, probe: true, waitMs: 0, reason: "" };
  }
  return { allowed: true, state, probe: false, waitMs: 0, reason: "" };
}

async function recordSyncCircuitSuccess({ extApi = defaultExt(), now = defaultNow } = {}) {
  const next = { ...emptyCircuitState(), updatedAt: now() };
  await storageSet({ [STORAGE_KEYS.CIRCUIT]: next }, extApi);
  return next;
}

async function recordSyncCircuitFailure(error, { extApi = defaultExt(), now = defaultNow } = {}) {
  const timestamp = now();
  const state = await getSyncCircuitState(extApi);
  const classification = classifySyncFailure(error);

  if (classification.kind === "ignored") {
    if (state.status !== "half-open") return state;
    const next = { ...emptyCircuitState(), updatedAt: timestamp };
    await storageSet({ [STORAGE_KEYS.CIRCUIT]: next }, extApi);
    return next;
  }

  const transientCount = classification.kind === "transient"
    ? state.consecutiveTransientFailures + 1
    : 0;
  const shouldOpen =
    classification.kind !== "transient"
    || transientCount >= TRANSIENT_FAILURE_THRESHOLD
    || state.status === "half-open";

  if (!shouldOpen) {
    const next = {
      ...emptyCircuitState(),
      consecutiveTransientFailures: transientCount,
      updatedAt: timestamp,
    };
    await storageSet({ [STORAGE_KEYS.CIRCUIT]: next }, extApi);
    return next;
  }

  const baseDuration = SYNC_CIRCUIT_DURATIONS_MS[classification.kind] || SYNC_CIRCUIT_DURATIONS_MS.transient;
  const durationMs = Math.max(baseDuration, classification.retryAfterMs || 0);
  const next = {
    status: "open",
    blockedUntil: timestamp + durationMs,
    reason: classification.reason,
    consecutiveTransientFailures: transientCount,
    updatedAt: timestamp,
  };
  await storageSet({ [STORAGE_KEYS.CIRCUIT]: next }, extApi);
  return next;
}

export async function getSyncCooldownState(extApi = defaultExt(), now = defaultNow) {
  const data = await storageGet(STORAGE_KEYS.SYNC_META, extApi);
  const meta = data?.[STORAGE_KEYS.SYNC_META] || {};
  const nextAllowedAt = Number(meta.nextAllowedAt || 0);
  const waitMs = Math.max(0, nextAllowedAt - now());
  return {
    allowed: waitMs <= 0,
    waitMs,
    nextAllowedAt,
    lastStatus: String(meta.lastStatus || ""),
    lastSyncedAt: Number(meta.lastSyncedAt || 0),
    reason: waitMs > 0
      ? `请求过于频繁，请 ${Math.ceil(waitMs / 1000)} 秒后重试`
      : "",
  };
}

async function setSyncCooldown({ success, extApi = defaultExt(), now = defaultNow }) {
  const timestamp = now();
  const cooldownMs = success ? DEFAULT_SYNC_COOLDOWN_MS : FAILED_SYNC_COOLDOWN_MS;
  const existing = (await storageGet(STORAGE_KEYS.SYNC_META, extApi))?.[STORAGE_KEYS.SYNC_META] || {};
  await storageSet(
    {
      [STORAGE_KEYS.SYNC_META]: {
        ...existing,
        lastFinishedAt: timestamp,
        lastStatus: success ? "success" : "error",
        lastSyncedAt: success ? timestamp : Number(existing.lastSyncedAt || 0),
        nextAllowedAt: timestamp + cooldownMs,
      },
    },
    extApi
  );
}

/* =========================================================================
 * 保存当前 Cookie & 完整同步编排
 * ========================================================================= */

export async function saveCurrentBrowserCookie({
  extApi = defaultExt(),
  fetchImpl = defaultFetch,
  wait = defaultWait,
  now = defaultNow,
  onLog,
} = {}) {
  const cookies = await getBlablalinkBrowserCookies(extApi);
  const token = cookies.find((c) => c.name === "game_token")?.value;
  if (!token) {
    return { success: false, reason: "NOT_LOGGED_IN", error: "当前浏览器未登录 Blablalink" };
  }

  const cookieStr = serializeBrowserCookies(cookies);
  const gameUid = parseCookieValue(cookieStr, "game_uid");
  const gameOpenId = parseCookieValue(cookieStr, "game_openid");

  let dnrActive = false;
  try {
    if (gameUid) {
      const reg = await sendRuntimeMessage(
        { type: "REGISTER_COOKIE_RULE", payload: { gameUid, cookie: cookieStr } },
        extApi
      );
      dnrActive = Boolean(reg?.ok);
    }

    let roleInfo = { roleName: "", areaId: "", authenticated: true };
    try {
      roleInfo = await fetchRoleInfo({
        cookie: cookieStr,
        gameUid,
        gameOpenId,
        useDnr: dnrActive,
        fetchImpl,
        wait,
        onDiagnostic: onLog,
      });
    } catch (err) {
      emitDiag(onLog, `自动解析角色信息失败（不影响保存 Cookie）: ${err?.message || err}`);
    }

    const prev = (await storageGet(STORAGE_KEYS.ACCOUNT, extApi))?.[STORAGE_KEYS.ACCOUNT] || {};
    const finalRoleName = roleInfo.roleName || prev.roleName || "";
    const finalAreaId = roleInfo.areaId || prev.areaId || "";

    const account = {
      ...prev,
      cookie: cookieStr,
      gameUid,
      gameOpenId,
      roleName: finalRoleName,
      areaId: finalAreaId,
      cookieUpdatedAt: now(),
    };
    await storageSet({ [STORAGE_KEYS.ACCOUNT]: account }, extApi);

    return {
      success: true,
      updated: Boolean(prev.cookie),
      account,
    };
  } finally {
    if (dnrActive) {
      await sendRuntimeMessage({ type: "UNREGISTER_COOKIE_RULES" }, extApi);
    }
  }
}

export async function syncAccountEquipments({
  server = "global",
  manualAreaId = "",
  forceDirectoryRefresh = false,
  extApi = defaultExt(),
  fetchImpl = defaultFetch,
  wait = defaultWait,
  now = defaultNow,
  emptyRetryDelayMs = EMPTY_SYNC_RETRY_DELAY_MS,
  playerRetryDelaysMs = PLAYER_INFO_RETRY_DELAYS_MS,
  onLog,
} = {}) {
  const parsedManual = parseManualAreaId(manualAreaId);
  if (!parsedManual.valid) {
    return {
      ok: false,
      blocked: false,
      error: "手动 area_id 格式无效，请留空或输入正整数",
    };
  }
  const manualOverride = !parsedManual.empty ? parsedManual.value : "";

  const cooldown = await getSyncCooldownState(extApi, now);
  if (!cooldown.allowed) {
    emitDiag(onLog, `⚠ ${cooldown.reason}`);
    return { ok: false, blocked: true, waitMs: cooldown.waitMs, error: cooldown.reason };
  }

  const circuitPermit = await acquireSyncCircuitPermit({ extApi, now });
  if (!circuitPermit.allowed) {
    emitDiag(onLog, `⚠ ${circuitPermit.reason}`);
    return { ok: false, blocked: true, waitMs: circuitPermit.waitMs, error: circuitPermit.reason };
  }

  let dnrRegistered = false;
  let syncSucceeded = false;

  try {
    emitDiag(onLog, "开始同步 Blablalink 角色与装备数据...");

    const savedData = await storageGet([STORAGE_KEYS.ACCOUNT, STORAGE_KEYS.SETTINGS], extApi);
    const savedAccount = savedData?.[STORAGE_KEYS.ACCOUNT] || {};

    const browserCookies = await getBlablalinkBrowserCookies(extApi);
    const browserCookieStr = serializeBrowserCookies(browserCookies);
    const hasBrowserToken = Boolean(parseCookieValue(browserCookieStr, "game_token"));

    const cookieStr = hasBrowserToken ? browserCookieStr : String(savedAccount.cookie || "");
    const gameToken = parseCookieValue(cookieStr, "game_token");
    if (!gameToken) {
      throw new Error("未检测到 Blablalink 登录态，请先点击「打开 Blablalink 登录」");
    }

    const gameUid = parseCookieValue(cookieStr, "game_uid") || String(savedAccount.gameUid || "");
    const gameOpenId = parseCookieValue(cookieStr, "game_openid") || String(savedAccount.gameOpenId || "");

    if (gameUid) {
      const reg = await sendRuntimeMessage(
        { type: "REGISTER_COOKIE_RULE", payload: { gameUid, cookie: cookieStr } },
        extApi
      );
      dnrRegistered = Boolean(reg?.ok);
    }

    let areaId = manualOverride;
    let roleName = String(savedAccount.roleName || "");
    let preloadedCharacters = null;

    if (areaId) {
      emitDiag(onLog, `使用手动 area_id=${areaId}，校验登录态...`);
      const checkResp = await postBlablalinkJson(
        USER_CHECK_LOGIN_URL,
        {},
        { accountId: gameUid, useDnr: dnrRegistered, fetchImpl, onDiagnostic: onLog }
      );
      if (!isApiResponseSuccessful(checkResp)) {
        throw new Error("Cookie 登录态已失效，请重新登录 Blablalink");
      }
    } else {
      const roleInfo = await fetchRoleInfo({
        cookie: cookieStr,
        gameUid,
        gameOpenId,
        useDnr: dnrRegistered,
        fetchImpl,
        wait,
        retryDelaysMs: playerRetryDelaysMs,
        onDiagnostic: onLog,
      });
      if (roleInfo.roleName) roleName = roleInfo.roleName;
      areaId = roleInfo.areaId;

      if (!areaId && !roleInfo.authenticated) {
        throw new Error("Blablalink 登录态已失效，请重新登录");
      }

      if (!areaId) {
        emitDiag(onLog, `玩家信息未返回 area_id，尝试探测 ${server.toUpperCase()} 候选区服...`);
        const probe = await discoverAreaIdByProbing({
          server,
          intlOpenId: gameOpenId,
          accountId: gameUid,
          useDnr: dnrRegistered,
          fetchImpl,
          onDiagnostic: onLog,
        });
        areaId = probe.areaId;
        if (probe.characters.length > 0) {
          preloadedCharacters = probe.characters;
        }
      }
    }

    if (!areaId) {
      throw new Error("自动获取 area_id 失败，请在下方手动输入 area_id 后重试");
    }

    emitDiag(onLog, `已确认玩家区服 area_id=${areaId}${roleName ? `（${roleName}）` : ""}`);

    const directoryItems = await fetchAndCacheNikkeDirectory({
      extApi,
      fetchImpl,
      forceRefresh: forceDirectoryRefresh,
      now,
      onDiagnostic: onLog,
    });
    emitDiag(onLog, `角色目录已就绪（共 ${directoryItems.length} 条）`);

    let userCharacters = [];
    let detailsResult = { characterDetails: [], stateEffects: [] };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      userCharacters = attempt === 1 && preloadedCharacters
        ? preloadedCharacters
        : await fetchUserCharacters({
            areaId,
            intlOpenId: gameOpenId,
            accountId: gameUid,
            useDnr: dnrRegistered,
            fetchImpl,
            onDiagnostic: onLog,
          });
      preloadedCharacters = null;

      if (userCharacters.length === 0) {
        if (attempt < 2) {
          emitDiag(onLog, `⚠ 持有角色列表为空，${emptyRetryDelayMs}ms 后重试...`);
          if (emptyRetryDelayMs > 0) await wait(emptyRetryDelayMs);
          continue;
        }
        throw new EmptySyncDataError("玩家持有角色列表为空，请确认服务器选择或手动 area_id 是否正确");
      }

      const nameCodes = userCharacters.map((c) => c.name_code);
      detailsResult = await fetchUserCharacterDetails({
        areaId,
        intlOpenId: gameOpenId,
        nameCodes,
        accountId: gameUid,
        useDnr: dnrRegistered,
        fetchImpl,
        onDiagnostic: onLog,
      });

      if (detailsResult.characterDetails.length === 0) {
        if (attempt < 2) {
          emitDiag(onLog, `⚠ 未返回任何角色详情，${emptyRetryDelayMs}ms 后重试...`);
          if (emptyRetryDelayMs > 0) await wait(emptyRetryDelayMs);
          continue;
        }
        throw new EmptySyncDataError("已持有角色但未返回任何角色详情");
      }

      break;
    }

    const timestamp = now();
    const snapshot = buildSyncedSnapshot({
      accountInfo: { roleName, areaId, gameUid, server },
      userCharacters,
      characterDetails: detailsResult.characterDetails,
      stateEffects: detailsResult.stateEffects,
      directoryItems,
      now: timestamp,
    });

    const nextAccount = {
      ...savedAccount,
      cookie: cookieStr,
      gameUid,
      gameOpenId,
      roleName,
      areaId,
      server,
      cookieUpdatedAt: hasBrowserToken ? timestamp : (savedAccount.cookieUpdatedAt || timestamp),
    };

    await storageSet(
      {
        [STORAGE_KEYS.SNAPSHOT]: snapshot,
        [STORAGE_KEYS.ACCOUNT]: nextAccount,
        [STORAGE_KEYS.SETTINGS]: {
          ...(savedData?.[STORAGE_KEYS.SETTINGS] || {}),
          server,
          manualAreaId: manualOverride,
        },
      },
      extApi
    );

    await recordSyncCircuitSuccess({ extApi, now });
    await setSyncCooldown({ success: true, extApi, now });
    syncSucceeded = true;

    emitDiag(
      onLog,
      `✓ 同步完成：共 ${snapshot.characterCount} 名妮姬（${snapshot.withAffixCount} 名含洗练词条）`
    );

    return { ok: true, snapshot, account: nextAccount };
  } catch (error) {
    const msg = error?.message || String(error);
    emitDiag(onLog, `✗ 同步失败：${msg}`);
    const nextCircuit = await recordSyncCircuitFailure(error, { extApi, now });
    const circuitMsg = formatCircuitReason(nextCircuit, now());
    if (circuitMsg) emitDiag(onLog, `⚠ ${circuitMsg}`);
    await setSyncCooldown({ success: false, extApi, now });
    return {
      ok: false,
      blocked: false,
      error: msg,
      circuitReason: circuitMsg,
    };
  } finally {
    if (dnrRegistered) {
      await sendRuntimeMessage({ type: "UNREGISTER_COOKIE_RULES" }, extApi);
    }
    if (!syncSucceeded) {
      // 确保冷却和状态保持一致（已在 catch 处理）
    }
  }
}
