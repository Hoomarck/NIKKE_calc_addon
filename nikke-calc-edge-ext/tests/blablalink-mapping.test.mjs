// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";

import {
  SIMP_CHARS,
  TRAD_CHARS,
  resolveNikkeNameCn,
  toSimplifiedChinese,
} from "../t2s.js";
import {
  CALC_TYPE_DEFS,
  EQUIP_PARTS,
  STORAGE_KEYS,
  SUMMARY_TYPE_ORDER,
  buildSyncedSnapshot,
  discoverAreaIdByProbing,
  fetchRoleInfo,
  parseEquipmentSlotsFromApi,
  summarizeCharacterEquipments,
  syncAccountEquipments,
} from "../blablalink-api.js";
import {
  RULE_ID_BASE,
  openOrFocusCalculatorTab,
  registerCookieRule,
  unregisterCookieRules,
} from "../background.js";

function createMockExt({
  cookies = [],
  initialStorage = {},
  tabsList = [],
} = {}) {
  const store = { ...initialStorage };
  let dynamicRules = [];
  const sentMessages = [];
  const createdTabs = [];
  const updatedTabs = [];
  const focusedWindows = [];

  const extApi = {
    cookies: {
      getAll: async () => cookies,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") {
            return keys in store ? { [keys]: store[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (k in store) out[k] = store[k];
            }
            return out;
          }
          return { ...store };
        },
        set: async (items) => {
          Object.assign(store, items);
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => dynamicRules.slice(),
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        dynamicRules = dynamicRules.filter((r) => !removeSet.has(r.id)).concat(addRules);
      },
    },
    tabs: {
      query: async () => tabsList,
      update: async (id, props) => {
        updatedTabs.push({ id, props });
        return { id };
      },
      create: async (props) => {
        const created = { id: 901, ...props };
        createdTabs.push(created);
        return created;
      },
    },
    windows: {
      update: async (id, props) => {
        focusedWindows.push({ id, props });
      },
    },
    runtime: {
      getURL: (rel) => `chrome-extension://test-ext-id/${rel}`,
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        if (msg.type === "REGISTER_COOKIE_RULE") {
          return registerCookieRule(msg.payload, extApi);
        }
        if (msg.type === "UNREGISTER_COOKIE_RULES") {
          return unregisterCookieRules(extApi);
        }
        return { ok: true };
      },
    },
  };

  return {
    extApi,
    store,
    getDynamicRules: () => dynamicRules.slice(),
    sentMessages,
    createdTabs,
    updatedTabs,
    focusedWindows,
  };
}

test("t2s table lengths match, cover 1200+ chars, and override 5143 -> 渡鸦", () => {
  const tradArr = Array.from(TRAD_CHARS);
  const simpArr = Array.from(SIMP_CHARS);
  assert.equal(tradArr.length, simpArr.length);
  assert.ok(tradArr.length >= 1200);
  assert.equal(new Set(tradArr).size, tradArr.length);

  assert.equal(toSimplifiedChinese("紅蓮：暗影"), "红莲：暗影");
  assert.equal(toSimplifiedChinese("愛麗絲與長髮公主"), "爱丽丝与长发公主");
  assert.equal(toSimplifiedChinese("布蘭兒、諾亞爾與餅乾"), "布兰儿、诺亚尔与饼干");
  assert.equal(resolveNikkeNameCn("5143", "蕾雯"), "渡鸦");
  assert.equal(resolveNikkeNameCn("5124", "灰姑娘"), "灰姑娘");
});

test("parseEquipmentSlotsFromApi maps all 9 types, keeps gaps, and infers missing levels", () => {
  const effectsMap = {
    1: { function_details: [{ function_type: "IncElementDmg", function_value: 2356, level: 11 }] },
    2: { function_details: [{ function_type: "StatAccuracyCircle", function_value: 477, level: 1 }] },
    3: { function_details: [{ function_type: "StatAmmoLoad", function_value: 6893, level: 11 }] },
    4: { function_details: [{ function_type: "StatAtk", function_value: 1251 }] }, // missing level -> infer 12
    5: { function_details: [{ function_type: "StatChargeDamage", function_value: 1463, level: 15 }] },
    6: { function_details: [{ function_type: "StatChargeTime", function_value: 492, level: 11 }] },
    7: { function_details: [{ function_type: "StatCriticalDamage", function_value: 1644, level: 11 }] },
    8: { function_details: [{ function_type: "StatCritical", function_value: 570, level: 11 }] },
    9: { function_details: [{ function_type: "StatDef", function_value: 970, level: 8 }] },
    99: { function_details: [{ function_type: "UnknownType", function_value: 999, level: 1 }] },
  };

  const detail = {
    head_equip_option1_id: 1,
    head_equip_option2_id: 2,
    head_equip_option3_id: 3,
    torso_equip_option1_id: 4,
    torso_equip_option2_id: 0, // gap preserved!
    torso_equip_option3_id: 5,
    arm_equip_option1_id: 6,
    arm_equip_option2_id: 7,
    arm_equip_option3_id: 8,
    leg_equip_option1_id: 9,
    leg_equip_option2_id: 99, // unknown -> null
    leg_equip_option3_id: 0,
  };

  assert.deepEqual(parseEquipmentSlotsFromApi(detail, "head", effectsMap), [
    { type: "elite", tier: 11, locked: false },
    { type: "hit", tier: 1, locked: false },
    { type: "ammo", tier: 11, locked: false },
  ]);

  assert.deepEqual(parseEquipmentSlotsFromApi(detail, "torso", effectsMap), [
    { type: "atk", tier: 12, locked: false },
    { type: null, tier: 1, locked: false },
    { type: "chg", tier: 15, locked: false },
  ]);

  assert.deepEqual(parseEquipmentSlotsFromApi(detail, "arm", effectsMap), [
    { type: "spd", tier: 11, locked: false },
    { type: "cdmg", tier: 11, locked: false },
    { type: "crit", tier: 11, locked: false },
  ]);

  assert.deepEqual(parseEquipmentSlotsFromApi(detail, "leg", effectsMap), [
    { type: "def", tier: 8, locked: false },
    { type: null, tier: 1, locked: false },
    { type: null, tier: 1, locked: false },
  ]);
});

test("summarizeCharacterEquipments uses integer basis points and highlights active part", () => {
  const equipments = [
    {
      slots: [
        { type: "atk", tier: 11, locked: false }, // 11.81%
        { type: "elite", tier: 12, locked: false }, // 24.96%
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: "atk", tier: 11, locked: false }, // 11.81%
        { type: "ammo", tier: 10, locked: false }, // 64.82%
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: "atk", tier: 11, locked: false }, // 11.81%
        { type: null, tier: 1, locked: false },
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: "elite", tier: 15, locked: false }, // 29.16%
        { type: null, tier: 1, locked: false },
        { type: null, tier: 1, locked: false },
      ],
    },
  ];

  const summary = summarizeCharacterEquipments(equipments, CALC_TYPE_DEFS, 1); // torso active
  const atk = summary.find((x) => x.id === "atk");
  const elite = summary.find((x) => x.id === "elite");
  const ammo = summary.find((x) => x.id === "ammo");
  const def = summary.find((x) => x.id === "def");

  assert.equal(atk.count, 3);
  assert.equal(atk.totalBp, 3543);
  assert.equal(atk.totalVal, 35.43); // exact, no float drift
  assert.deepEqual(atk.partTiers, [11, 11, 11, null]);
  assert.equal(atk.inActivePart, true);

  assert.equal(elite.count, 2);
  assert.equal(elite.totalVal, 54.12);
  assert.deepEqual(elite.partTiers, [12, null, null, 15]);
  assert.equal(elite.inActivePart, false);

  assert.equal(ammo.count, 1);
  assert.equal(ammo.totalVal, 64.82);
  assert.equal(ammo.inActivePart, true);

  assert.equal(def.count, 0);
  assert.equal(def.totalVal, 0);
  assert.equal(def.inActivePart, false);
});

test("summarizeCharacterEquipments sorts hit types first and zero-count types last", () => {
  const equipments = [
    {
      slots: [
        { type: "hit", tier: 5, locked: false }, // 7.59%
        { type: "atk", tier: 11, locked: false }, // 11.81%
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: "elite", tier: 12, locked: false }, // 24.96%
        { type: "ammo", tier: 10, locked: false }, // 64.82%
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: "atk", tier: 11, locked: false }, // 11.81%
        { type: null, tier: 1, locked: false },
        { type: null, tier: 1, locked: false },
      ],
    },
    {
      slots: [
        { type: null, tier: 1, locked: false },
        { type: null, tier: 1, locked: false },
        { type: null, tier: 1, locked: false },
      ],
    },
  ];

  const summary = summarizeCharacterEquipments(equipments, CALC_TYPE_DEFS, 0); // helmet active

  assert.equal(summary.length, 9);

  // 命中的词条前置，组内保持 SUMMARY_TYPE_ORDER 相对顺序
  assert.deepEqual(summary.slice(0, 4).map((x) => x.id), ["elite", "atk", "ammo", "hit"]);
  assert.ok(summary.slice(0, 4).every((x) => x.count > 0));

  // 未命中的 0 条词条排至末尾，组内同样保持 SUMMARY_TYPE_ORDER 相对顺序
  assert.deepEqual(summary.slice(4).map((x) => x.id), ["crit", "cdmg", "spd", "chg", "def"]);
  assert.ok(summary.slice(4).every((x) => x.count === 0 && x.totalBp === 0 && x.totalVal === 0));

  // 排序不改动数值本身：整数基点累加，无浮点漂移
  const atk = summary.find((x) => x.id === "atk");
  assert.equal(atk.count, 2);
  assert.equal(atk.totalBp, 2362);
  assert.equal(atk.totalVal, 23.62);
  assert.deepEqual(atk.partTiers, [11, null, 11, null]);
  assert.equal(atk.inActivePart, true);

  const hit = summary.find((x) => x.id === "hit");
  assert.equal(hit.count, 1);
  assert.equal(hit.totalVal, 7.59);
  assert.equal(hit.inActivePart, true);

  const elite = summary.find((x) => x.id === "elite");
  assert.equal(elite.totalVal, 24.96);
  assert.equal(elite.inActivePart, false);
});

test("summarizeCharacterEquipments keeps all nine types in SUMMARY_TYPE_ORDER when nothing is hit", () => {
  assert.deepEqual(
    [...SUMMARY_TYPE_ORDER],
    ["elite", "atk", "ammo", "crit", "cdmg", "spd", "chg", "hit", "def"]
  );

  const emptyPart = {
    slots: [
      { type: null, tier: 1, locked: false },
      { type: null, tier: 1, locked: false },
      { type: null, tier: 1, locked: false },
    ],
  };
  const summary = summarizeCharacterEquipments(
    [emptyPart, emptyPart, emptyPart, emptyPart],
    CALC_TYPE_DEFS,
    2
  );

  assert.equal(summary.length, 9);
  // 全部 0 条时顺序保持 SUMMARY_TYPE_ORDER 不变
  assert.deepEqual(summary.map((x) => x.id), [...SUMMARY_TYPE_ORDER]);
  assert.ok(summary.every((x) => x.count === 0 && x.totalBp === 0 && x.totalVal === 0));
  assert.ok(summary.every((x) => x.inActivePart === false));
  assert.ok(summary.every((x) => Array.isArray(x.partTiers) && x.partTiers.length === 4));
});

test("fetchRoleInfo recovers from 1300015 via CheckLogin + GetUserInfoNew + GetUserPrivacySetting", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = url.split("?")[0].split("/").pop();
    const body = JSON.parse(init?.body || "{}");
    calls.push({ endpoint, body });

    if (endpoint === "GetUserGamePlayerInfo") {
      if (body.intl_openid === "99-canonical-id") {
        return new Response(JSON.stringify({ code: 0, data: { area_id: 84, role_name: "OldName" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 1300015, message: "system error" }), { status: 200 });
    }
    if (endpoint === "CheckLogin") {
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }
    if (endpoint === "GetUserInfoNew") {
      return new Response(JSON.stringify({ code: 0, data: { info: { intl_openid: "99-canonical-id" } } }), { status: 200 });
    }
    if (endpoint === "GetUserPrivacySetting") {
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }
    if (endpoint === "GetUserProfileBasicInfo") {
      return new Response(JSON.stringify({ code: 0, data: { basic_info: { nickname: "CommanderX", area_id: 84 } } }), { status: 200 });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const role = await fetchRoleInfo({
    cookie: "game_token=tok; game_uid=1001; game_openid=12345",
    fetchImpl,
    wait: async () => {},
    retryDelaysMs: [0, 0],
  });

  assert.equal(role.areaId, "84");
  assert.equal(role.roleName, "CommanderX");
  assert.equal(role.authenticated, true);
  assert.ok(calls.some((c) => c.endpoint === "GetUserInfoNew"));
  assert.ok(calls.some((c) => c.endpoint === "GetUserPrivacySetting" && c.body.intl_openid === "99-canonical-id"));
});

test("discoverAreaIdByProbing selects matching candidate for global and hmt", async () => {
  const fetchGlobal = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.nikke_area_id === 84) {
      return new Response(JSON.stringify({ code: 0, data: { characters: [] } }), { status: 200 });
    }
    if (body.nikke_area_id === 82) {
      return new Response(JSON.stringify({ code: 0, data: { characters: [{ name_code: 101 }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { characters: [] } }), { status: 200 });
  };

  const g = await discoverAreaIdByProbing({ server: "global", fetchImpl: fetchGlobal });
  assert.equal(g.areaId, "82");
  assert.equal(g.characters.length, 1);

  const fetchHmt = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ code: 0, data: { characters: body.nikke_area_id === 91 ? [{ name_code: 202 }] : [] } }),
      { status: 200 }
    );
  };
  const h = await discoverAreaIdByProbing({ server: "hmt", fetchImpl: fetchHmt });
  assert.equal(h.areaId, "91");
});

test("syncAccountEquipments writes snapshot, registers/cleans DNR rule, enforces cooldown & circuit breaker", async () => {
  let fakeNow = 1_700_000_000_000;
  const { extApi, store, getDynamicRules, sentMessages } = createMockExt({
    cookies: [
      { domain: ".blablalink.com", path: "/", name: "game_token", value: "tok123" },
      { domain: ".blablalink.com", path: "/", name: "game_uid", value: "778899" },
      { domain: ".blablalink.com", path: "/", name: "game_openid", value: "op55" },
    ],
  });

  let rateLimited = false;
  let charCallCount = 0;

  const fetchImpl = async (url) => {
    if (url.includes("c4619ec83335bcfd7b23e43600520dc7.json")) {
      return new Response(
        JSON.stringify([
          { id: 1, name_code: 5143, name_localkey: { name: "蕾雯" }, element_id: { element: { element: "Iron" } }, use_burst_skill: "Step3", corporation: "Abnormal" },
          { id: 2, name_code: 5124, name_localkey: { name: "紅蓮" }, element_id: { element: { element: "Wind" } }, use_burst_skill: "Step3", corporation: "Pilgrim" },
        ]),
        { status: 200 }
      );
    }
    if (url.includes("1bf030193826e243c2e195f951a4be00.json")) {
      return new Response(
        JSON.stringify([
          { id: 1, name_code: 5143, name_localkey: { name: "Raven" } },
          { id: 2, name_code: 5124, name_localkey: { name: "Scarlet" } },
        ]),
        { status: 200 }
      );
    }
    if (rateLimited) {
      return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
    }
    const endpoint = url.split("?")[0].split("/").pop();
    if (endpoint === "GetUserGamePlayerInfo") {
      return new Response(JSON.stringify({ code: 0, data: { area_id: 84, role_name: "NikkeTester" } }), { status: 200 });
    }
    if (endpoint === "GetUserProfileBasicInfo") {
      return new Response(JSON.stringify({ code: 0, data: { basic_info: { nickname: "NikkeTester" } } }), { status: 200 });
    }
    if (endpoint === "GetUserCharacters") {
      charCallCount += 1;
      if (charCallCount === 1) {
        // Test empty retry recovery on 1st attempt!
        return new Response(JSON.stringify({ code: 0, data: { characters: [] } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            characters: [
              { name_code: 5143, lv: 300, combat: 95000 },
              { name_code: 5124, lv: 300, combat: 105000 },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (endpoint === "GetUserCharacterDetails") {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            state_effects: [
              { id: 501, function_details: [{ function_type: "StatAtk", function_value: 1181, level: 11 }] },
              { id: 502, function_details: [{ function_type: "IncElementDmg", function_value: 2496, level: 12 }] },
            ],
            character_details: [
              {
                name_code: 5143,
                lv: 300,
                combat: 95000,
                head_equip_lv: 5,
                head_equip_option1_id: 501,
                head_equip_option2_id: 0,
                head_equip_option3_id: 502,
              },
              {
                name_code: 5124,
                lv: 300,
                combat: 105000,
                torso_equip_lv: 5,
                torso_equip_option1_id: 502,
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const res1 = await syncAccountEquipments({
    server: "global",
    extApi,
    fetchImpl,
    wait: async () => {},
    now: () => fakeNow,
    emptyRetryDelayMs: 0,
    playerRetryDelaysMs: [0, 0],
  });

  assert.equal(res1.ok, true);
  assert.equal(charCallCount, 2); // retried empty data once
  assert.equal(getDynamicRules().length, 0); // cleaned up in finally
  assert.ok(sentMessages.some((m) => m.type === "REGISTER_COOKIE_RULE"));
  assert.ok(sentMessages.some((m) => m.type === "UNREGISTER_COOKIE_RULES"));

  const snap = store[STORAGE_KEYS.SNAPSHOT];
  assert.equal(snap.characterCount, 2);
  assert.equal(snap.account.roleName, "NikkeTester");
  const raven = snap.characters.find((c) => c.nameCode === "5143");
  assert.equal(raven.nameCn, "渡鸦");
  assert.equal(raven.affixCount, 2);
  assert.deepEqual(raven.equipments[0].slots, [
    { type: "atk", tier: 11, locked: false },
    { type: null, tier: 1, locked: false },
    { type: "elite", tier: 12, locked: false },
  ]);

  // 2nd immediate call should be blocked by 60s cooldown
  fakeNow += 5_000;
  const resCooldown = await syncAccountEquipments({
    server: "global",
    extApi,
    fetchImpl,
    wait: async () => {},
    now: () => fakeNow,
  });
  assert.equal(resCooldown.ok, false);
  assert.equal(resCooldown.blocked, true);

  // Advance past 60s cooldown and trigger HTTP 429 rate-limit circuit breaker
  fakeNow += 65_000;
  rateLimited = true;
  const res429 = await syncAccountEquipments({
    server: "global",
    extApi,
    fetchImpl,
    wait: async () => {},
    now: () => fakeNow,
  });
  assert.equal(res429.ok, false);
  assert.equal(store[STORAGE_KEYS.CIRCUIT].status, "open");

  // Even after failed 10s cooldown passes, circuit breaker keeps blocking for 30m
  fakeNow += 15_000;
  const resBlockedByCircuit = await syncAccountEquipments({
    server: "global",
    extApi,
    fetchImpl,
    wait: async () => {},
    now: () => fakeNow,
  });
  assert.equal(resBlockedByCircuit.ok, false);
  assert.equal(resBlockedByCircuit.blocked, true);
});

test("background.js registers/unregisters DNR cookie rules and opens or focuses calculator tab", async () => {
  const mock1 = createMockExt({ tabsList: [] });
  const regRes = await registerCookieRule({ gameUid: "123+45", cookie: "game_token=abc" }, mock1.extApi);
  assert.equal(regRes.ok, true);
  const rules = mock1.getDynamicRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, RULE_ID_BASE);
  assert.ok(rules[0].condition.regexFilter.includes("123\\+45"));

  const unregRes = await unregisterCookieRules(mock1.extApi);
  assert.equal(unregRes.removed, 1);
  assert.equal(mock1.getDynamicRules().length, 0);

  const openNew = await openOrFocusCalculatorTab({}, mock1.extApi);
  assert.equal(openNew.reused, false);
  assert.equal(mock1.createdTabs.length, 1);
  assert.equal(mock1.createdTabs[0].url, "chrome-extension://test-ext-id/calculator.html");

  const mock2 = createMockExt({
    tabsList: [{ id: 42, windowId: 7, url: "chrome-extension://test-ext-id/calculator.html" }],
  });
  const openReuse = await openOrFocusCalculatorTab({}, mock2.extApi);
  assert.equal(openReuse.reused, true);
  assert.equal(openReuse.tabId, 42);
  assert.deepEqual(mock2.updatedTabs, [{ id: 42, props: { active: true } }]);
  assert.deepEqual(mock2.focusedWindows, [{ id: 7, props: { focused: true } }]);
});
