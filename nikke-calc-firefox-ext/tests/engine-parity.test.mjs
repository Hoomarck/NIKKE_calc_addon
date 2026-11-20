// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");
const SOURCE_HTML_PATH = path.resolve(EXT_ROOT, "..", "NIKKE-装备洗词条期望计算器.html");
const ENGINE_JS_PATH = path.join(EXT_ROOT, "engine.js");

function extractHtmlEngineSource() {
  const html = fs.readFileSync(SOURCE_HTML_PATH, "utf8");
  const lines = html.split(/\r?\n/);
  return lines.slice(1063, 3006).join("\n") + "\n";
}

function loadEngineFromSource(source, filename) {
  const context = {
    window: {},
    globalThis: {},
    Math,
    Number,
    Array,
    Object,
    String,
    Boolean,
    JSON,
    Infinity,
    NaN,
    isFinite,
    parseFloat,
    parseInt,
    Date,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return context.NIKKE_ENGINE || context.window.NIKKE_ENGINE;
}

test("engine.js matches original HTML NIKKE_ENGINE source byte-for-byte (SHA-256)", () => {
  const expectedSrc = extractHtmlEngineSource();
  const actualSrc = fs.readFileSync(ENGINE_JS_PATH, "utf8").replace(/\r\n/g, "\n");

  const expectedHash = crypto.createHash("sha256").update(expectedSrc).digest("hex");
  const actualHash = crypto.createHash("sha256").update(actualSrc).digest("hex");

  assert.equal(actualHash, expectedHash);
  assert.equal(actualSrc, expectedSrc);
});

test("engine.js produces identical solve() results to original HTML engine across all scenarios", () => {
  const origEngine = loadEngineFromSource(extractHtmlEngineSource(), "orig-html-engine.js");
  const extEngine = loadEngineFromSource(fs.readFileSync(ENGINE_JS_PATH, "utf8"), "engine.js");

  assert.equal(extEngine.VERSION, origEngine.VERSION);

  const buildCfg = (reqs) => {
    const cfg = extEngine.defaultConfig();
    cfg.reqs = reqs;
    return cfg;
  };

  const scenarios = [
    {
      name: "Preset 1: 攻优弹 (empty start)",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 1 },
        { cands: ["elite"], minTier: 1 },
        { cands: ["ammo"], minTier: 1 },
      ]),
      start: extEngine.defaultStart(),
      opts: {},
    },
    {
      name: "Preset 2: 攻优弹 (>=11 阶, empty start)",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["ammo"], minTier: 11 },
      ]),
      start: extEngine.defaultStart(),
      opts: {},
    },
    {
      name: "Preset 3: 攻优 + 三选一",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 1 },
        { cands: ["elite"], minTier: 1 },
        { cands: ["cdmg", "crit", "ammo"], minTier: 1 },
      ]),
      start: extEngine.defaultStart(),
      opts: {},
    },
    {
      name: "Preset 4: 攻优 >=11 + 三选一 >=7",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["cdmg", "crit", "ammo"], minTier: 7 },
      ]),
      start: extEngine.defaultStart(),
      opts: {},
    },
    {
      name: "Sparse slots (S1 + S3 populated, S2 null) with pre-lock",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["ammo"], minTier: 8 },
      ]),
      start: {
        slots: [
          { type: "atk", tier: 12, locked: true },
          { type: null, tier: 1, locked: false },
          { type: "elite", tier: 6, locked: false },
        ],
      },
      opts: {},
    },
    {
      name: "Phase 2 only (p1Only / act === -1)",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["ammo"], minTier: 11 },
      ]),
      start: {
        slots: [
          { type: "atk", tier: 5, locked: false },
          { type: "elite", tier: 12, locked: false },
          { type: "ammo", tier: 3, locked: false },
        ],
      },
      opts: {},
    },
    {
      name: "All requirements already satisfied (0 stones)",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["ammo"], minTier: 7 },
      ]),
      start: {
        slots: [
          { type: "atk", tier: 12, locked: true },
          { type: "elite", tier: 11, locked: false },
          { type: "ammo", tier: 8, locked: false },
        ],
      },
      opts: {},
    },
    {
      name: "Manual strategy comparison enabled",
      cfg: buildCfg([
        { cands: ["atk"], minTier: 11 },
        { cands: ["elite"], minTier: 11 },
        { cands: ["ammo"], minTier: 7 },
      ]),
      start: {
        slots: [
          { type: "hit", tier: 4, locked: false },
          { type: "elite", tier: 9, locked: false },
          { type: "def", tier: 2, locked: false },
        ],
      },
      opts: {
        manual: {
          enabled: true,
          slotPriority: [2, 1, 0],
          maxLocks: 2,
          minBand: 1,
          enterPhase2: true,
        },
      },
    },
  ];

  function toHostValue(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      return Array.from(v, (item) => toHostValue(item));
    }
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val !== "function") out[k] = toHostValue(val);
    }
    return out;
  }

  for (const sc of scenarios) {
    const expected = toHostValue(origEngine.solve(
      structuredClone(sc.cfg),
      structuredClone(sc.start),
      structuredClone(sc.opts)
    ));
    const actual = toHostValue(extEngine.solve(
      structuredClone(sc.cfg),
      structuredClone(sc.start),
      structuredClone(sc.opts)
    ));

    assert.equal(actual.ok, expected.ok, `${sc.name}: ok mismatch`);
    assert.equal(actual.p1Only, expected.p1Only, `${sc.name}: p1Only mismatch`);
    assert.equal(actual.states, expected.states, `${sc.name}: states mismatch`);
    assert.equal(actual.startLocked, expected.startLocked, `${sc.name}: startLocked mismatch`);
    assert.deepEqual(actual.totals, expected.totals, `${sc.name}: totals mismatch`);
    assert.deepEqual(actual.chosenStart, expected.chosenStart, `${sc.name}: chosenStart mismatch`);
    assert.deepEqual(actual.startOptions, expected.startOptions, `${sc.name}: startOptions mismatch`);
    assert.deepEqual(actual.guide, expected.guide, `${sc.name}: guide mismatch`);
    assert.deepEqual(actual.phase2, expected.phase2, `${sc.name}: phase2 mismatch`);
  }
});
