/*!
 * NIKKE T10 装备洗词条 —— 精确期望计算引擎 v1.0
 * ---------------------------------------------------------------------------
 * 纯 JS，无 DOM 依赖，可在浏览器 / Node 中直接运行。
 *
 * 【模型概述】
 *   两个阶段：
 *     阶段一「变更效果」：重掷未锁定槽位的 种类 + 阶数。
 *     阶段二「变更数值」：保留种类，重掷未锁定槽位的阶数。
 *   状态 = (已锁定槽位集合 mask, 已锁定槽位的词条标签 labels)
 *     词条标签 = (种类 type, 档位 band)，band = 该种类"满足了几条最低阶数要求"。
 *     band 天然区分了"低阶暂存词条"与"已达标词条"。
 *
 *   阶段一是一个有限状态马尔可夫链：动作 = 本次洗练要额外锁定哪些槽位。
 *   由于锁定只增不减（解锁后重锁不会带来任何信息优势），状态图是 DAG，
 *   按 |mask| 降序即可一次求解，得到精确期望。
 *
 *   阶段二在"达标槽位一律锁定、未达标槽位解锁重掷"的假设下也是 DAG，
 *   逐层精确求和。该假设与游戏常规打法一致（不会主动重刷已达标的词条）。
 *
 *   所有概率均为解析枚举：
 *     槽位出现概率 × 不放回加权的联合概率 × 阶数分布
 *   不使用蒙特卡洛近似。
 *
 * 【成本向量】统一 5 分量，便于任意线性组合：
 *   [0] 阶段一洗练石头  [1] 阶段二洗练石头  [2] 锁定石头
 *   [3] 阶段一洗练次数  [4] 阶段二洗练次数
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.NIKKE_ENGINE = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =========================================================================
   * 0. 常量
   * ========================================================================= */
  var VERSION = '1.0.0';
  var TIER_MAX = 15;
  var ABSENT = 0;                 // 槽位没有出现词条
  var JUNK = 145;                 // 非目标种类的合并标签
  var INF = 1e15;
  var NC = 5;

  function lab(type, band) { return 1 + type * 16 + band; }
  function labType(l) { return Math.floor((l - 1) / 16); }
  function labBand(l) { return (l - 1) % 16; }

  /* =========================================================================
   * 1. 默认数据
   * ========================================================================= */
  var TYPE_DEFS = [
    { id: 'elite', name: '优越代码伤害', abbr: '优', weight: 10,
      values: [9.54, 10.94, 12.34, 13.75, 15.15, 16.55, 17.95, 19.35, 20.75, 22.15, 23.56, 24.96, 26.36, 27.76, 29.16] },
    { id: 'hit', name: '命中率', abbr: '命', weight: 12,
      values: [4.77, 5.47, 6.18, 6.88, 7.59, 8.29, 8.99, 9.70, 10.40, 11.11, 11.81, 12.51, 13.22, 13.92, 14.63] },
    { id: 'ammo', name: '最大装弹数', abbr: '弹', weight: 12,
      values: [27.84, 31.93, 36.05, 40.16, 44.28, 48.39, 52.50, 56.60, 60.71, 64.82, 68.93, 73.04, 77.15, 81.26, 85.37] },
    { id: 'atk', name: '攻击力', abbr: '攻', weight: 10,
      values: [4.77, 5.47, 6.18, 6.88, 7.59, 8.29, 8.99, 9.70, 10.40, 11.11, 11.81, 12.51, 13.22, 13.92, 14.63] },
    { id: 'chg', name: '蓄力伤害', abbr: '蓄', weight: 12,
      values: [4.77, 5.47, 6.18, 6.88, 7.59, 8.29, 8.99, 9.70, 10.40, 11.11, 11.81, 12.51, 13.22, 13.92, 14.63] },
    { id: 'spd', name: '蓄力速度', abbr: '速', weight: 12,
      values: [1.98, 2.28, 2.57, 2.86, 3.16, 3.45, 3.75, 4.04, 4.33, 4.63, 4.92, 5.22, 5.51, 5.80, 6.09] },
    { id: 'cdmg', name: '暴击伤害', abbr: '伤', weight: 12,
      values: [6.64, 7.62, 8.60, 9.58, 10.56, 11.54, 12.52, 13.50, 14.48, 15.46, 16.44, 17.42, 18.40, 19.38, 20.36] },
    { id: 'crit', name: '暴击率', abbr: '率', weight: 10,
      values: [2.30, 2.64, 2.98, 3.32, 3.66, 4.00, 4.34, 4.68, 5.02, 5.34, 5.70, 6.04, 6.38, 6.72, 7.07] },
    { id: 'def', name: '防御力', abbr: '防', weight: 10,
      values: [4.77, 5.47, 6.18, 6.88, 7.59, 8.29, 8.99, 9.70, 10.40, 11.11, 11.81, 12.51, 13.22, 13.92, 14.63] }
  ];
  var DEFAULT_TIER_PROBS = [12, 12, 12, 12, 12, 7, 7, 7, 7, 7, 1, 1, 1, 1, 1];
  var DEFAULT_SLOT_PROBS = [100, 50, 30];

  function defaultConfig() {
    return {
      types: TYPE_DEFS.map(function (t) {
        return { id: t.id, name: t.name, abbr: t.abbr, weight: t.weight, values: t.values.slice() };
      }),
      tierProbs: DEFAULT_TIER_PROBS.slice(),
      slotProbs: DEFAULT_SLOT_PROBS.slice(),
      costs: { base: 1, lock1: 2, lock2: 3, lock3: 4, extra: 1 },
      reqs: [
        { cands: ['atk'], minTier: 1 },
        { cands: ['elite'], minTier: 1 },
        { cands: ['ammo'], minTier: 1 }
      ]
    };
  }

  function defaultStart() {
    return { slots: [
      { type: null, tier: 1, locked: false },
      { type: null, tier: 1, locked: false },
      { type: null, tier: 1, locked: false }
    ] };
  }

  /* =========================================================================
   * 2. 工具
   * ========================================================================= */
  function num(x, d) {
    var v = (typeof x === 'number') ? x : parseFloat(x);
    if (!isFinite(v)) return (d === undefined ? 0 : d);
    return v;
  }
  function isBad(x) {
    if (x === '' || x === null || x === undefined) return true;
    var v = parseFloat(x);
    return !isFinite(v);
  }
  function pc(x) { var c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
  function rnd(n, d) { var p = Math.pow(10, d); return Math.round(n * p) / p; }
  function v0() { return [0, 0, 0, 0, 0]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4]]; }
  function vmul(a, k) { return [a[0] * k, a[1] * k, a[2] * k, a[3] * k, a[4] * k]; }
  function addTo(a, b, k) {
    a[0] += b[0] * k; a[1] += b[1] * k; a[2] += b[2] * k; a[3] += b[3] * k; a[4] += b[4] * k;
    return a;
  }
  function tot(v) { return v[0] + v[1] + v[2]; }
  function isInf(v) { return !isFinite(tot(v)) || tot(v) >= INF / 2; }

  /* =========================================================================
   * 3. 参数校验
   * ========================================================================= */
  function validateConfig(cfg) {
    var errors = [];
    if (!cfg || !cfg.types || !cfg.reqs) { return ['配置对象不完整。']; }
    var i, j;

    // --- 词条权重 ---
    var wsum = 0, badW = false;
    for (i = 0; i < cfg.types.length; i++) {
      if (isBad(cfg.types[i].weight)) badW = true;
      var w = num(cfg.types[i].weight, 0);
      if (w < 0) badW = true;
      wsum += w;
    }
    if (cfg.types.length !== 9) errors.push('词条种类必须为 9 种（游戏中固定 9 种词条）。');
    if (badW) errors.push('词条种类权重存在空值或负数。');
    if (Math.abs(wsum - 100) > 1e-6) errors.push('词条种类权重合计必须为 100%，当前为 ' + rnd(wsum, 3) + '%。');

    // --- 阶数概率 ---
    var tsum = 0, badT = false;
    if (!cfg.tierProbs || cfg.tierProbs.length !== TIER_MAX) {
      errors.push('阶数概率表必须包含 1~15 阶共 15 个数值。');
    } else {
      for (i = 0; i < TIER_MAX; i++) {
        if (isBad(cfg.tierProbs[i])) badT = true;
        var p = num(cfg.tierProbs[i], 0);
        if (p < 0) badT = true;
        tsum += p;
      }
      if (badT) errors.push('阶数概率存在空值或负数。');
      if (Math.abs(tsum - 100) > 1e-6) errors.push('阶数概率合计必须为 100%，当前为 ' + rnd(tsum, 3) + '%。');
    }

    // --- 槽位概率 ---
    if (!cfg.slotProbs || cfg.slotProbs.length !== 3) {
      errors.push('槽位出现概率必须为 3 个数值。');
    } else {
      for (i = 0; i < 3; i++) {
        if (isBad(cfg.slotProbs[i])) { errors.push('第 ' + (i + 1) + ' 槽位出现概率为空值。'); continue; }
        var sp = num(cfg.slotProbs[i], 0);
        if (sp < 0 || sp > 100) errors.push('第 ' + (i + 1) + ' 槽位出现概率必须位于 0%~100% 之间。');
      }
    }

    // --- 成本 ---
    var c = cfg.costs || {};
    var ckeys = [['base', '单次基础洗练消耗'], ['lock1', '第 1 个锁定消耗'], ['lock2', '第 2 个锁定消耗'],
                 ['lock3', '第 3 个锁定消耗'], ['extra', '锁定后每次额外消耗']];
    for (i = 0; i < ckeys.length; i++) {
      if (isBad(c[ckeys[i][0]])) { errors.push('成本参数「' + ckeys[i][1] + '」不能为空。'); continue; }
      if (num(c[ckeys[i][0]], 0) < 0) errors.push('成本参数「' + ckeys[i][1] + '」不能为负数。');
    }
    if (num(c.lock3, 0) < num(c.lock2, 0) || num(c.lock2, 0) < num(c.lock1, 0)) {
      errors.push('锁定成本应满足：第 1 个锁 ≤ 第 2 个锁 ≤ 第 3 个锁。');
    }

    // --- 目标 ---
    var reqs = cfg.reqs || [];
    var nameOf = function (id) {
      for (var k = 0; k < cfg.types.length; k++) if (cfg.types[k].id === id) return cfg.types[k].name;
      return id;
    };
    if (reqs.length < 1) errors.push('请至少设置 1 个目标词条条件。');
    if (reqs.length > 3) errors.push('目标条件最多 3 项（装备仅有 3 个槽位）。');
    for (i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (!r.cands || !r.cands.length) { errors.push('第 ' + (i + 1) + ' 项目标未选择任何候选词条。'); continue; }
      var mt = num(r.minTier, 0);
      if (isBad(r.minTier) || mt < 1 || mt > TIER_MAX || Math.floor(mt) !== mt) {
        errors.push('第 ' + (i + 1) + ' 项目标的最低阶数必须为 1~15 的整数。');
      }
      for (j = 0; j < r.cands.length; j++) {
        var ti = -1;
        for (var k2 = 0; k2 < cfg.types.length; k2++) if (cfg.types[k2].id === r.cands[j]) ti = k2;
        if (ti < 0) errors.push('第 ' + (i + 1) + ' 项目标包含未知词条。');
        else if (num(cfg.types[ti].weight, 0) <= 0) {
          errors.push('第 ' + (i + 1) + ' 项目标包含「' + cfg.types[ti].name + '」，但该词条权重为 0，永远无法洗出。');
        }
      }
      if (!isBad(r.minTier) && mt >= 1 && mt <= TIER_MAX) {
        var pg = 0;
        for (var q = mt - 1; q < TIER_MAX; q++) pg += num((cfg.tierProbs || [])[q], 0);
        if (pg <= 0) errors.push('第 ' + (i + 1) + ' 项目标要求 ≥' + mt + ' 阶，但该阶数区间概率为 0，永远无法达成。');
      }
    }

    // --- 目标可行性（互斥）---
    if (errors.length === 0) {
      var idx = function (id) {
        for (var k = 0; k < cfg.types.length; k++) if (cfg.types[k].id === id) return k;
        return -1;
      };
      var reqTypes = [];
      for (i = 0; i < reqs.length; i++) {
        var arr = [];
        for (j = 0; j < reqs[i].cands.length; j++) {
          var t2 = idx(reqs[i].cands[j]);
          if (t2 >= 0) arr.push(t2);
        }
        reqTypes.push(arr);
      }
      if (!canAssignDistinct(reqTypes, 0, {})) {
        errors.push('目标条件无法同时满足：同件装备的词条种类互斥，请检查是否重复要求了同一种词条。');
      }
      var strictMap = {};
      for (i = 0; i < reqTypes.length; i++) {
        if (reqTypes[i].length === 1) {
          var key = reqTypes[i][0];
          if (strictMap[key] !== undefined) {
            errors.push('「' + nameOf(reqs[strictMap[key]].cands[0]) + '」被第 ' + (strictMap[key] + 1) +
              ' 项与第 ' + (i + 1) + ' 项重复要求，但同名词条不可能同时出现在两个槽位。');
          }
          strictMap[key] = i;
        }
      }

      /* --- 数值唯一性：各目标的阶数要求必须能落到互不相同的阶数上 ---
         同一件装备不会出现两个相同数值，所以 N 条目标最多占用 N 个不同阶数，
         从高到低排第 k 高的要求不能超过 15 - (k - 1)。 */
      var mins = [];
      for (i = 0; i < reqs.length; i++) mins.push(Math.round(num(reqs[i].minTier, 1)));
      mins.sort(function (a, b) { return b - a; });
      for (i = 0; i < mins.length; i++) {
        if (mins[i] > TIER_MAX - i) {
          errors.push('目标无法同时达成：同一件装备的数值互不相同，' + (i + 1) + ' 条目标都要求 ≥' + mins[i] +
            ' 阶时需要 ' + (i + 1) + ' 个不同阶数，但 ≥' + mins[i] + ' 阶只剩 ' + (TIER_MAX - mins[i] + 1) + ' 个档位。');
          break;
        }
      }
    }
    return errors;
  }

  function canAssignDistinct(reqTypes, ri, used) {
    if (ri >= reqTypes.length) return true;
    var arr = reqTypes[ri];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (used[t]) continue;
      used[t] = 1;
      if (canAssignDistinct(reqTypes, ri + 1, used)) { used[t] = 0; return true; }
      used[t] = 0;
    }
    return false;
  }

  /* =========================================================================
   * 4. 模型构建
   * ========================================================================= */
  function createModel(cfg) {
    var types = cfg.types;
    var n = types.length;
    var weights = [], wsum = 0, i, j, t;
    for (i = 0; i < n; i++) { weights.push(num(types[i].weight, 0)); wsum += weights[i]; }

    var tierRaw = [], tsum = 0;
    for (i = 0; i < TIER_MAX; i++) { tierRaw.push(num(cfg.tierProbs[i], 0)); tsum += tierRaw[i]; }
    if (tsum <= 0) tsum = 1;
    var tp = tierRaw.map(function (p) { return p / tsum; });

    var slotP = cfg.slotProbs.map(function (p) { return Math.max(0, Math.min(1, num(p, 0) / 100)); });

    var reqs = [];
    for (i = 0; i < cfg.reqs.length; i++) {
      var r = cfg.reqs[i], cands = [], cs = {};
      for (j = 0; j < r.cands.length; j++) {
        for (t = 0; t < n; t++) if (types[t].id === r.cands[j]) { cands.push(t); cs[t] = 1; }
      }
      reqs.push({ cands: cands, candSet: cs, minTier: Math.round(num(r.minTier, 1)), index: i });
    }

    // 每种词条的阶数阈值集合 → 档位（band）
    var thrByType = [];
    for (t = 0; t < n; t++) thrByType.push([]);
    for (i = 0; i < reqs.length; i++) {
      for (j = 0; j < reqs[i].cands.length; j++) {
        t = reqs[i].cands[j];
        if (thrByType[t].indexOf(reqs[i].minTier) < 0) thrByType[t].push(reqs[i].minTier);
      }
    }

    var bandTable = [], bandProbs = [], bandCount = [], reqNeed = [], isTarget = [], targetTypes = [];
    for (t = 0; t < n; t++) {
      thrByType[t].sort(function (a, b) { return a - b; });
      var thr = thrByType[t];
      var bt = [], bp = [];
      for (i = 0; i < TIER_MAX; i++) {
        var tier = i + 1, band = 0;
        for (var k = 0; k < thr.length; k++) if (tier >= thr[k]) band++;
        bt.push(band);
      }
      for (i = 0; i <= thr.length; i++) bp.push(0);
      for (i = 0; i < TIER_MAX; i++) bp[bt[i]] += tp[i];
      bandTable.push(bt);
      bandProbs.push(bp);
      bandCount.push(thr.length + 1);
      isTarget.push(thr.length > 0);
      if (thr.length > 0) targetTypes.push(t);
      var needArr = [];
      for (i = 0; i < reqs.length; i++) needArr.push(0);
      reqNeed.push(needArr);
    }
    for (i = 0; i < reqs.length; i++) {
      for (j = 0; j < reqs[i].cands.length; j++) {
        t = reqs[i].cands[j];
        reqNeed[t][i] = thrByType[t].indexOf(reqs[i].minTier) + 1;
      }
    }

    var costs = {
      base: num(cfg.costs.base, 1),
      lock: [num(cfg.costs.lock1, 2), num(cfg.costs.lock2, 3), num(cfg.costs.lock3, 4)],
      extra: num(cfg.costs.extra, 1)
    };

    var labelList = [];
    for (t = 0; t < n; t++) {
      var ls = [];
      if (isTarget[t]) for (var b = 0; b < bandCount[t]; b++) ls.push(lab(t, b));
      labelList.push(ls);
    }

    return {
      n: n, types: types, weights: weights, wsum: wsum, tp: tp, slotP: slotP,
      reqs: reqs, nReqs: reqs.length, thrByType: thrByType,
      bandTable: bandTable, bandProbs: bandProbs, bandCount: bandCount,
      reqNeed: reqNeed, isTarget: isTarget, targetTypes: targetTypes,
      labelList: labelList, costs: costs,
      // 每次建模独立缓存，避免不同配置之间串味
      _branchCache: (typeof Map !== 'undefined') ? new Map() : null,
      _p2Cache: (typeof Map !== 'undefined') ? new Map() : null,
      name: function (t) { return (t >= 0 && t < n) ? types[t].name : '—'; },
      abbr: function (t) { return (t >= 0 && t < n) ? types[t].abbr : '—'; }
    };
  }

  function probGE(model, minTier) {
    var m = Math.max(1, Math.min(TIER_MAX, Math.round(minTier)));
    var s = 0;
    for (var i = m - 1; i < TIER_MAX; i++) s += model.tp[i];
    return s;
  }
  function tierProb(model, tier) {
    var k = Math.max(1, Math.min(TIER_MAX, Math.round(tier))) - 1;
    return model.tp[k];
  }
  function bandOfTier(model, t, tier) {
    var k = Math.max(1, Math.min(TIER_MAX, Math.round(tier))) - 1;
    return model.bandTable[t][k];
  }
  function isTargetLabel(model, l) {
    if (l === ABSENT) return false;
    var t = labType(l);
    return t >= 0 && t < model.n && model.isTarget[t];
  }
  function typeSatisfies(model, l, r) {
    if (l === ABSENT) return false;
    var t = labType(l);
    if (t < 0 || t >= model.n) return false;
    return model.reqNeed[t][r] > 0;
  }
  function bandSatisfies(model, l, r) {
    if (l === ABSENT) return false;
    var t = labType(l);
    if (t < 0 || t >= model.n) return false;
    var need = model.reqNeed[t][r];
    return need > 0 && labBand(l) >= need;
  }
  function maxBandLabel(model, t) { return lab(t, model.bandCount[t] - 1); }

  /* =========================================================================
   * 5. 单次「变更效果」的精确联合分布
   * ========================================================================= */
  var branchCache = (typeof Map !== 'undefined') ? new Map() : null;

  /**
   * 枚举一次「变更效果」后，未锁定槽位的全部可能结果。
   * @param model
   * @param unlocked 未锁定槽位下标数组（升序）
   * @param excludedMask 已被锁定占用的种类位掩码
   * @returns [{p, labels:[...]}]  labels 顺序与 unlocked 一致
   */
  function buildBranches(model, unlocked, excludedMask) {
    var n = model.n;
    var L = unlocked.length;
    if (L === 0) return [{ p: 1, labels: [] }];

    var branchCache = model._branchCache;
    var cacheKey = unlocked.join(',') + '|' + excludedMask;
    if (branchCache && branchCache.has(cacheKey)) return branchCache.get(cacheKey);

    var remW = 0, t;
    for (t = 0; t < n; t++) {
      if (excludedMask & (1 << t)) continue;
      if (model.weights[t] <= 0) continue;
      remW += model.weights[t];
    }

    var map = {}, out = [];
    var labels = [];

    function pushLeaf(p) {
      var key = 0, i;
      for (i = 0; i < L; i++) key = key * 200 + labels[i];
      if (map[key] === undefined) { map[key] = out.length; out.push({ p: 0, labels: labels.slice() }); }
      out[map[key]].p += p;
    }

    function rec(i, drawn, wLeft, p) {
      if (i === L) { pushLeaf(p); return; }
      var s = unlocked[i];
      var ap = model.slotP[s];
      if (ap < 1 - 1e-12) {
        labels.push(ABSENT);
        rec(i + 1, drawn, wLeft, p * (1 - ap));
        labels.pop();
      }
      if (ap <= 0 || wLeft <= 0) return;
      for (var k = 0; k < n; k++) {
        if (excludedMask & (1 << k)) continue;
        if (drawn & (1 << k)) continue;
        var w = model.weights[k];
        if (w <= 0) continue;
        var pType = ap * (w / wLeft);
        var nextW = wLeft - w;
        var bp = model.bandProbs[k];
        var tg = model.isTarget[k];
        for (var b = 0; b < bp.length; b++) {
          if (bp[b] <= 0) continue;
          labels.push(tg ? lab(k, b) : JUNK);
          rec(i + 1, drawn | (1 << k), nextW, p * pType * bp[b]);
          labels.pop();
        }
      }
    }

    if (remW <= 0) {
      var res0 = [{ p: 1, labels: [] }];
      for (var z = 0; z < L; z++) res0[0].labels.push(ABSENT);
      return res0;
    }
    rec(0, 0, remW, 1);
    out.sort(function (a, b) { return b.p - a.p; });

    // 合并极端小概率分支，防止数值噪声
    var merged = [];
    for (var i2 = 0; i2 < out.length; i2++) {
      if (out[i2].p < 1e-13) continue;
      merged.push(out[i2]);
    }
    if (!merged.length) merged = out.slice(0, 1);

    if (branchCache) branchCache.set(cacheKey, merged);
    return merged;
  }

  /* =========================================================================
   * 6. 目标 ↔ 槽位 的可行分配
   * ========================================================================= */
  function completeAssignments(model, view) {
    var R = model.nReqs;
    var res = [], assign = [], used = [false, false, false];
    function rec(r) {
      if (r === R) { res.push(assign.slice()); return; }
      for (var s = 0; s < 3; s++) {
        if (used[s]) continue;
        if (!typeSatisfies(model, view[s], r)) continue;
        used[s] = true;
        assign.push({ req: r, slot: s });
        rec(r + 1);
        assign.pop();
        used[s] = false;
      }
    }
    rec(0);
    return res;
  }

  /* 判断一个"锁定标签 + 可用空槽"的组合是否还有解 */
  function statePossible(model, lockedLabelsBySlot, mask, availSlots) {
    var R = model.nReqs;
    var usedSlot = [false, false, false];
    var usedType = {};
    var s, i;
    for (s = 0; s < 3; s++) {
      if (!(mask & (1 << s))) continue;
      var l = lockedLabelsBySlot[s];
      if (l === ABSENT) continue;
      usedType[labType(l)] = 1;
    }
    function rec(r) {
      if (r === R) return true;
      for (var s2 = 0; s2 < 3; s2++) {
        if (usedSlot[s2]) continue;
        var ll = lockedLabelsBySlot[s2];
        if (!(mask & (1 << s2)) && !(availSlots & (1 << s2))) continue;
        if (!typeSatisfies(model, ll, r)) continue;
        usedSlot[s2] = true;
        var ok = rec(r + 1);
        usedSlot[s2] = false;
        if (ok) return true;
      }
      for (var t = 0; t < model.n; t++) {
        if (usedType[t]) continue;
        if (!(model.reqNeed[t][r] > 0)) continue;
        if (model.weights[t] <= 0) continue;
        // 至少存在一个"未锁定槽位"能洗出该种类
        var can = false;
        for (var s3 = 0; s3 < 3; s3++) {
          if (mask & (1 << s3)) continue;
          if (!(availSlots & (1 << s3))) continue;
          if (model.slotP[s3] <= 0) continue;
          can = true;
        }
        if (!can) continue;
        usedType[t] = 1;
        var ok2 = rec(r + 1);
        usedType[t] = 0;
        if (ok2) return true;
      }
      return false;
    }
    return rec(0);
  }

  /* =========================================================================
   * 7. 阶段二：变更数值（保留 / 应用 二选一 · 精确动态规划）
   * -------------------------------------------------------------------------
   * 规则（按玩家补充）：每次「变更数值」会先给出新数值，玩家可以「保留当前」
   *      或「应用更改」；同一件装备上不会出现两个相同数值。
   *      · 所以不锁定也能一直保留当前词条（拒绝即保留），只是要付洗练费；
   *      · 当前 3 个数值都占着池子 → 未锁定槽位只能从剩下的 12 个阶数里抽；
   *      · 把低阶（出现率高）的数值留着，就把最常见的档位挡在池外，
   *        其余槽位抽到高阶的概率随之提高 —— 这正是「先留存高概率低数值词条」；
   *      · 只有新数值达标时才「应用」并锁定，此刻才付锁定费。
   * 状态：n 个互不相同的当前阶数（达标集合由阶数直接决定）→ S 只增不减，
   *      按 |S| 从大到小一次逆推即得精确期望。
   * 成本：每次 = base + (已达标锁定数 + 额外锁定数) × extra；应用新达标时付锁定费。
   * ========================================================================= */
  function lockDeltaCost(model, fromCount, toCount) {
    var s = 0;
    for (var k = fromCount; k < toCount; k++) {
      s += model.costs.lock[Math.min(k, model.costs.lock.length - 1)];
    }
    return s;
  }

  function buildPhase2(model, assignment, extraLocked) {
    var n = assignment.length;
    var full = (1 << n) - 1;
    var i, k, t;
    var m = [];
    for (i = 0; i < n; i++) {
      m.push(Math.max(1, Math.min(15, Math.round(model.reqs[assignment[i].req].minTier))));
    }

    var p2Cache = model._p2Cache;
    var key = assignment.map(function (a) { return a.slot + ':' + a.req; }).join(',') + '|' + extraLocked;
    if (p2Cache && p2Cache.has(key)) return p2Cache.get(key);

    function toll(kLocked) { return model.costs.base + (kLocked + extraLocked) * model.costs.extra; }
    function lockPay(fromCount, toCount) { return lockDeltaCost(model, fromCount + extraLocked, toCount + extraLocked); }

    function satOf(vals) {
      var s = 0;
      for (var k2 = 0; k2 < n; k2++) if (vals[k2] >= m[k2]) s |= (1 << k2);
      return s;
    }
    function codeOf(vals) {
      var c = 0;
      for (var k3 = 0; k3 < n; k3++) c = c * 16 + vals[k3];
      return c;
    }
    /* 把任意外部给的阶数整理成「n 个互不相同、1..15」的合法状态 */
    function normVals(vals) {
      var out = [], used = {};
      for (var k4 = 0; k4 < n; k4++) {
        var v = Math.round((vals && vals[k4]) || m[k4]);
        if (!(v >= 1)) v = 1;
        if (v > 15) v = 15;
        while (used[v] && v < 15) v++;
        while (used[v] && v > 1) v--;
        used[v] = 1;
        out.push(v);
      }
      return out;
    }

    /* ---- 状态：n 个互不相同的阶数 ---- */
    var states = [], idxOf = {};
    (function rec(k5, vals, used) {
      if (k5 === n) {
        var c = codeOf(vals);
        idxOf[c] = states.length;
        states.push({ vals: vals.slice(), code: c, S: satOf(vals) });
        return;
      }
      for (var tt = 1; tt <= 15; tt++) {
        if (used & (1 << tt)) continue;
        if (model.tp[tt - 1] <= 0) continue;
        vals.push(tt);
        rec(k5 + 1, vals, used | (1 << tt));
        vals.pop();
      }
    })(0, [], 0);

    var nS = states.length;
    var C2 = new Float64Array(nS);    // 洗练石
    var CL = new Float64Array(nS);    // 锁定石
    var CR = new Float64Array(nS);    // 洗数值次数

    /* 不放回抽取：unlocked 个槽位从「去掉 exclMask 后的阶数池」依次抽（权重按出现率） */
    var drawCache = {};
    function drawsFor(unlocked, exclMask) {
      var ck = unlocked.join(',') + '|' + exclMask;
      if (drawCache[ck]) return drawCache[ck];
      if (!unlocked.length) { drawCache[ck] = [{ tiers: [], p: 1 }]; return drawCache[ck]; }
      var totalW = 0;
      for (t = 1; t <= 15; t++) {
        if (exclMask & (1 << t)) continue;
        if (model.tp[t - 1] > 0) totalW += model.tp[t - 1];
      }
      if (totalW <= 0) { drawCache[ck] = [{ tiers: [], p: 1 }]; return drawCache[ck]; }
      var out = [], acc = [];
      (function rec2(idx, left, p, used) {
        if (idx === unlocked.length) { out.push({ tiers: acc.slice(), p: p }); return; }
        if (left <= 1e-15) return;
        for (var v = 1; v <= 15; v++) {
          if (exclMask & (1 << v)) continue;
          if (used & (1 << v)) continue;
          var w = model.tp[v - 1];
          if (w <= 0) continue;
          acc.push(v);
          rec2(idx + 1, left - w, p * (w / left), used | (1 << v));
          acc.pop();
        }
      })(0, totalW, 1, 0);
      drawCache[ck] = out;
      return out;
    }

    /* ---- 逆推：按 |S| 从大到小 ---- */
    var order = [];
    for (i = 0; i < nS; i++) order.push(i);
    order.sort(function (a, b) { return pc(states[b].S) - pc(states[a].S); });

    for (var oi = 0; oi < nS; oi++) {
      var id = order[oi];
      var st = states[id];
      if (st.S === full) { C2[id] = 0; CL[id] = 0; CR[id] = 0; continue; }
      var unlocked = [];
      for (i = 0; i < n; i++) if (!(st.S & (1 << i))) unlocked.push(i);
      /* 当前所有数值都在装备上 → 整池排除；未锁定槽位从剩余阶数中不放回抽取 */
      var excl = 0;
      for (i = 0; i < n; i++) excl |= (1 << st.vals[i]);
      var draws = null;
      var rollCost = toll(pc(st.S));
      var accC2 = 0, accCL = 0, accR = 0, pReject = 0;
      /* 就地递归枚举「不放回抽取」的结果，避免为每个状态分配数组 */
      var pool = [], pw = [], psum = 0;
      for (t = 1; t <= 15; t++) {
        if (excl & (1 << t)) continue;
        if (model.tp[t - 1] <= 0) continue;
        pool.push(t);
        pw.push(model.tp[t - 1]);
        psum += model.tp[t - 1];
      }
      var baseCode = st.code, unit = [];
      var u0 = 1;
      for (i = n - 1; i >= 0; i--) { unit[i] = u0; u0 *= 16; }

      (function walk(idx, left, p, used, code, S2) {
        if (idx === unlocked.length) {
          if (S2 === st.S) { pReject += p; return; }
          var fee = (S2 === full) ? 0 : lockPay(pc(st.S), pc(S2));
          var nid = idxOf[code];
          accC2 += p * C2[nid];
          accCL += p * (fee + CL[nid]);
          accR += p * (1 + CR[nid]);
          return;
        }
        if (left <= 1e-15) return;
        var si = unlocked[idx];
        var oldCode = Math.floor(code / unit[si]) % 16;
        for (var pi = 0; pi < pool.length; pi++) {
          var v = pool[pi];
          if (used & (1 << v)) continue;
          var w = pw[pi];
          var nc = code + (v - oldCode) * unit[si];
          var ns = S2;
          if (v >= m[si]) ns |= (1 << si);
          walk(idx + 1, left - w, p * (w / left), used | (1 << v), nc, ns);
        }
      })(0, psum, 1, excl, baseCode, st.S);

      var den = 1 - pReject;
      if (den <= 1e-12) { C2[id] = INF; CL[id] = INF; CR[id] = INF; continue; }
      C2[id] = (rollCost + accC2) / den;
      CL[id] = accCL / den;
      CR[id] = (1 + accR) / den;
    }

    var tbl = {
      assignment: assignment, n: n, full: full, m: m, extraLocked: extraLocked,
      q: m.map(function (mm) { return probGE(model, mm); }),
      toll: toll,
      lockPay: lockPay,
      states: states,
      /* 从「当前阶数组合」出发的阶段二期望（已达标槽位按已锁定计） */
      get: function (S0, vals) {
        var nv = normVals(vals);
        var id = idxOf[codeOf(nv)];
        if (id === undefined) return [INF, INF, INF, INF, INF];
        if (states[id].S === full) return [0, 0, 0, 0, 0];
        return [0, C2[id], CL[id], 0, CR[id]];
      },
      lockSetOf: function (S0) { return S0; },
      stop: function (S0) { return S0 === full; },
      /* 报告用：给定当前阶数组合，返回逐槽边际达标率与「本轮至少提升一个」的概率 */
      stats: function (S0, vals) {
        var nv = normVals(vals);
        var S = satOf(nv);
        var excl = 0, k6;
        for (k6 = 0; k6 < n; k6++) excl |= (1 << nv[k6]);
        var un = [], draws, per = [], pNone = 0;
        for (k6 = 0; k6 < n; k6++) if (!(S & (1 << k6))) un.push(k6);
        for (k6 = 0; k6 < n; k6++) per.push(0);
        draws = drawsFor(un, excl);
        for (var d2 = 0; d2 < draws.length; d2++) {
          var any = false;
          for (var u2 = 0; u2 < un.length; u2++) {
            if (draws[d2].tiers[u2] >= m[un[u2]]) { any = true; per[un[u2]] += draws[d2].p; }
          }
          if (!any) pNone += draws[d2].p;
        }
        return { q: per, probImprove: 1 - pNone, S: S };
      }
    };

    if (p2Cache) p2Cache.set(key, tbl);
    return tbl;
  }

  /* 高斯消元：A 为 n*n 行主序，B 为 n*k，返回解 */
  function solveLinear(A, B, n, k) {
    var i, j, p, c;
    for (i = 0; i < n; i++) {
      var maxv = Math.abs(A[i * n + i]), piv = i;
      for (j = i + 1; j < n; j++) {
        if (Math.abs(A[j * n + i]) > maxv) { maxv = Math.abs(A[j * n + i]); piv = j; }
      }
      if (maxv < 1e-14) continue;
      if (piv !== i) {
        for (c = 0; c < n; c++) { var t1 = A[i * n + c]; A[i * n + c] = A[piv * n + c]; A[piv * n + c] = t1; }
        for (c = 0; c < k; c++) { var t2 = B[i * k + c]; B[i * k + c] = B[piv * k + c]; B[piv * k + c] = t2; }
      }
      var d = A[i * n + i];
      for (j = i + 1; j < n; j++) {
        var f = A[j * n + i] / d;
        if (f === 0) continue;
        for (c = i; c < n; c++) A[j * n + c] -= f * A[i * n + c];
        for (c = 0; c < k; c++) B[j * k + c] -= f * B[i * k + c];
      }
    }
    for (i = n - 1; i >= 0; i--) {
      var dd = A[i * n + i];
      for (c = 0; c < k; c++) {
        var sum = B[i * k + c];
        for (j = i + 1; j < n; j++) sum -= A[i * n + j] * B[j * k + c];
        B[i * k + c] = Math.abs(dd) < 1e-14 ? 0 : sum / dd;
      }
    }
    return B;
  }

  /* 标签 → 该槽位当前阶数的最小一致取值（band 是按「最低阶数要求」切的档）
     阶段一的标签只保留档位，这里取「恰好落进该档的最小阶数」作为代表值。 */
  function labelTier(model, l) {
    if (!l || l === ABSENT || l === JUNK) return 0;
    var t = labType(l), b = labBand(l);
    if (t < 0 || t >= model.n) return 0;
    var thr = model.thrByType[t];
    if (!thr || !thr.length) return 0;
    if (b <= 0) return 1;                       // 未达任何门槛 → 取该档下界
    return thr[Math.min(b, thr.length) - 1];
  }

  /* 把「目标槽位视图」转成一组互不相同的当前数值：
     已达标的槽位取恰好达标的阶数，未达标的槽位取最低的空闲阶数（保证不达标）。 */
  function tiersFromView(model, a, view) {
    var n = a.length, out = [], used = {}, i, v;
    for (i = 0; i < n; i++) {
      var req = model.reqs[a[i].req];
      var mt = Math.max(1, Math.min(15, Math.round(req.minTier)));
      var sat = bandSatisfies(model, view[a[i].slot], a[i].req);
      v = sat ? Math.max(mt, labelTier(model, view[a[i].slot]) || mt) : 0;
      if (sat) { while (used[v] && v < 15) v++; }
      out.push(v);
      if (sat) used[v] = 1;
    }
    for (i = 0; i < n; i++) {
      if (out[i] > 0) continue;
      var mt2 = Math.max(1, Math.min(15, Math.round(model.reqs[a[i].req].minTier)));
      v = 1;
      while (v < mt2 && used[v]) v++;
      if (v >= mt2) v = Math.max(1, mt2 - 1);
      used[v] = 1;
      out[i] = v;
    }
    return out;
  }

  /* 由"当前视图 + 当前锁定"求阶段二最优成本向量 */
  function phase2Entry(model, view, mask, fixedMask) {
    var asg = completeAssignments(model, view);
    if (!asg.length) return null;
    var best = null, bestInfo = null;
    for (var ai = 0; ai < asg.length; ai++) {
      var a = asg[ai];
      var S = 0, L = 0, used = 0, i;
      var vals = [0, 0, 0];
      for (i = 0; i < a.length; i++) {
        used |= (1 << a[i].slot);
        if (bandSatisfies(model, view[a[i].slot], a[i].req)) S |= (1 << i);
        if (mask & (1 << a[i].slot)) L |= (1 << i);
        vals[i] = labelTier(model, view[a[i].slot]);
      }
      L = L & S;   // 未达标却被锁定的槽位：免费解锁
      var extraLocked = 0;
      for (var s = 0; s < 3; s++) {
        if (fixedMask & (1 << s)) extraLocked++;
        else if ((mask & (1 << s)) && !(used & (1 << s))) extraLocked++;
      }
      var tbl = buildPhase2(model, a, extraLocked);
      var valsT = tiersFromView(model, a, view);
      var v = tbl.get(S, valsT);
      if (isInf(v)) continue;
      /* 阶段二要求「达标即锁定」：把当前已达标但还没锁的槽位补锁上 */
      var pay = (S === (1 << tbl.n) - 1) ? 0 : lockDeltaCost(model, pc(L) + extraLocked, pc(S) + extraLocked);
      v = [v[0], v[1], v[2] + pay, v[3], v[4]];
      if (best === null || tot(v) < tot(best)) {
        best = v;
        bestInfo = { tbl: tbl, S: S, L: L, asg: a, extraLocked: extraLocked, vals: vals, pay: pay };
      }
    }
    if (best && bestInfo) best._info = bestInfo;
    return best;
  }

  /* =========================================================================
   * 8. 阶段一：有限状态马尔可夫决策过程（DAG）
   * ========================================================================= */
  function keyOf(mask, labels) {
    var k = mask;
    for (var i = 0; i < labels.length; i++) k = k * 200 + labels[i];
    return k;
  }
  function labelsAt(mask, view) {
    var out = [];
    for (var s = 0; s < 3; s++) if (mask & (1 << s)) out.push(view[s]);
    return out;
  }
  function asView(mask, labels) {
    var view = [ABSENT, ABSENT, ABSENT], li = 0;
    for (var s = 0; s < 3; s++) if (mask & (1 << s)) view[s] = labels[li++];
    return view;
  }

  function createPhase1(model, fixedMask, fixedLabels, baseMask, baseLabels) {
    var fixedCount = pc(fixedMask);
    var maxLock = 3;                    // 理论上最多锁 3 个；实际由"可洗槽位≥1"约束
    baseMask = baseMask || 0;           // 玩家进入本阶段时已经锁住的槽位（不会被重洗）
    baseLabels = baseLabels || [];
    var states = [];
    var byKey = {};

    // 生成所有 mask：必须包含 baseMask（玩家的锁定是既定事实，不可被"清空"）
    var masks = [];
    for (var m = 0; m < 8; m++) {
      if (m & fixedMask) continue;
      if ((m & baseMask) !== baseMask) continue;           // 已锁定的槽位必须保持锁定
      var freeCnt = pc(m) + fixedCount;
      if (freeCnt > maxLock) continue;
      if (3 - freeCnt < 1) continue;                       // 至少要留 1 个可洗槽位
      masks.push(m);
    }
    masks.sort(function (a, b) { return pc(a) - pc(b); });

    masks.forEach(function (mask) {
      var slots = [], unlocked = [];
      for (var s = 0; s < 3; s++) {
        if (mask & (1 << s)) slots.push(s);
        else if (!(fixedMask & (1 << s))) unlocked.push(s);
      }
      // 玩家已有的锁定词条必须先占用组合位置，否则会与真实状态不一致
      var baseSlots = [];
      for (var bs = 0; bs < 3; bs++) if (baseMask & (1 << bs)) baseSlots.push(bs);
      var excl = 0;
      for (var s2 = 0; s2 < 3; s2++) if (fixedMask & (1 << s2)) excl |= (1 << labType(fixedLabels[s2]));

      // 枚举锁定的词条标签组合（种类互斥、升序）
      var combos = [];
      (function rec(i, acc, usedType) {
        if (i === slots.length) { combos.push(acc.slice()); return; }
        var thisSlot = slots[i];
        var bIdx = baseSlots.indexOf(thisSlot);
        if (bIdx >= 0) {                       // 该槽位是玩家已锁定的 → 标签固定
          acc.push(baseLabels[bIdx]);
          rec(i + 1, acc, usedType);
          acc.pop();
          return;
        }
        for (var ti = 0; ti < model.targetTypes.length; ti++) {
          var t = model.targetTypes[ti];
          if (usedType[t]) continue;
          usedType[t] = 1;
          var ls = model.labelList[t];
          for (var bi = 0; bi < ls.length; bi++) {
            acc.push(ls[bi]);
            rec(i + 1, acc, usedType);
            acc.pop();
          }
          usedType[t] = 0;
        }
      })(0, [], {});
      if (slots.length === 0) combos = [[]];

      var availMask = 0;
      for (var s3 = 0; s3 < 3; s3++) {
        if (mask & (1 << s3)) continue;
        if (fixedMask & (1 << s3)) continue;
        availMask |= (1 << s3);
      }

      combos.forEach(function (labels) {
        var key = keyOf(mask, labels);
        if (byKey[key]) return;
        // 排除集合 = 该状态真正锁定的种类 + 永久锁定的非目标种类
        var exclState = excl;
        for (var j = 0; j < labels.length; j++) exclState |= (1 << labType(labels[j]));
        var branches = buildBranches(model, unlocked, exclState);
        var st = {
          key: key, mask: mask, labels: labels, unlocked: unlocked,
          excl: exclState,
          branches: branches,
          acts: new Int32Array(branches.length).fill(mask),
          feasible: statePossible(model, asView(mask, labels), mask, availMask)
        };
        byKey[key] = st;
        states.push(st);
      });
    });

    // 按 |mask| 降序 → 拓扑序
    states.sort(function (a, b) {
      var d = pc(b.mask) - pc(a.mask);
      return d !== 0 ? d : (a.key - b.key);
    });

    var api = {
      states: states, fixedMask: fixedMask, fixedLabels: fixedLabels,
      fixedCount: fixedCount, maxLock: maxLock, model: model,
      stateOf: function (mask, labels) { return byKey[keyOf(mask, labels)] || null; },
      toll: function (mask) { return model.costs.base + (pc(mask) + fixedCount) * model.costs.extra; },
      lockDelta: function (from, to) {
        var c1 = pc(from) + fixedCount, c2 = pc(to) + fixedCount;
        var s = 0;
        for (var k = c1; k < c2; k++) s += model.costs.lock[Math.min(k, model.costs.lock.length - 1)];
        return s;
      },
      candidates: function (mask, view) {
        var res = [mask];
        var lockedNow = pc(mask) + fixedCount;
        if (lockedNow >= maxLock) return res;
        if (3 - lockedNow < 2) return res;      // 锁满 3 个就没法洗了
        var cs = [];
        for (var s = 0; s < 3; s++) {
          if (mask & (1 << s)) continue;
          if (fixedMask & (1 << s)) continue;
          if (!isTargetLabel(model, view[s])) continue;
          cs.push(s);
        }
        for (var a = 0; a < cs.length; a++) {
          res.push(mask | (1 << cs[a]));
          for (var b = a + 1; b < cs.length; b++) {
            if (lockedNow + 2 > 3 - 1) continue;   // 保证仍留 1 个可洗槽位
            res.push(mask | (1 << cs[a]) | (1 << cs[b]));
          }
        }
        return res;
      }
    };
    return api;
  }

  /* 给定状态，用当前动作策略求值 */
  function evalPolicy(p1, W, actOf) {
    var model = p1.model;
    var list = p1.states;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (!st.feasible) { W[st.key] = [INF, INF, INF, INF, INF]; continue; }
      var acc = v0(), pSelf = 0, bad = false;
      for (var bi = 0; bi < st.branches.length; bi++) {
        var br = st.branches[bi];
        var view = asView(st.mask, st.labels);
        var ui = 0;
        for (var s = 0; s < 3; s++) {
          if (st.mask & (1 << s)) continue;
          if (p1.fixedMask & (1 << s)) continue;
          view[s] = br.labels[ui++];
        }
        var act = actOf(st, bi, view);
        if (act < 0) {
          var p2 = phase2Entry(model, view, st.mask, p1.fixedMask);
          if (p2 === null) { bad = true; break; }
          addTo(acc, [0, p2[1], p2[2], 0, p2[4]], br.p);
          continue;
        }
        if (act === st.mask) { pSelf += br.p; continue; }
        var nxt = p1.stateOf(act, labelsAt(act, view));
        if (!nxt || !nxt.feasible) { bad = true; break; }
        var v = vadd(W[nxt.key], [0, 0, p1.lockDelta(st.mask, act), 0, 0]);
        addTo(acc, v, br.p);
      }
      if (bad) { W[st.key] = [INF, INF, INF, INF, INF]; continue; }
      if (pSelf >= 1 - 1e-14) { W[st.key] = [INF, INF, INF, INF, INF]; continue; }
      var base = [p1.toll(st.mask), 0, 0, 1, 0];
      var out = v0();
      for (var c = 0; c < NC; c++) out[c] = (base[c] + acc[c]) / (1 - pSelf);
      W[st.key] = out;
    }
  }

  /* 策略改进 */
  function improvePolicy(p1, W) {
    var model = p1.model;
    var list = p1.states, changed = false;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (!st.feasible) continue;
      for (var bi = 0; bi < st.branches.length; bi++) {
        var br = st.branches[bi];
        var view = asView(st.mask, st.labels);
        var ui = 0;
        for (var s = 0; s < 3; s++) {
          if (st.mask & (1 << s)) continue;
          if (p1.fixedMask & (1 << s)) continue;
          view[s] = br.labels[ui++];
        }
        var bestAct = st.acts[bi], bestCost = Infinity;
        // 选项 1：直接进入阶段二
        var p2 = phase2Entry(model, view, st.mask, p1.fixedMask);
        if (p2 !== null) { bestCost = tot([0, p2[1], p2[2], 0, p2[4]]); bestAct = -1; }
        // 选项 2：继续洗种类
        var cands = p1.candidates(st.mask, view);
        for (var ci = 0; ci < cands.length; ci++) {
          var act = cands[ci];
          if (act === st.mask) {
            var w0 = W[st.key];
            if (!isInf(w0) && tot(w0) < bestCost) { bestCost = tot(w0); bestAct = act; }
          } else {
            var nxt = p1.stateOf(act, labelsAt(act, view));
            if (!nxt || !nxt.feasible) continue;
            var wv = W[nxt.key];
            if (isInf(wv)) continue;
            var c1 = tot(wv) + p1.lockDelta(st.mask, act);
            if (c1 < bestCost) { bestCost = c1; bestAct = act; }
          }
        }
        if (bestAct !== st.acts[bi]) { st.acts[bi] = bestAct; changed = true; }
      }
    }
    return changed;
  }

  function runPolicyIteration(p1) {
    var W = {};
    for (var it = 0; it < 200; it++) {
      evalPolicy(p1, W, function (st, bi) { return st.acts[bi]; });
      if (!improvePolicy(p1, W)) break;
    }
    evalPolicy(p1, W, function (st, bi) { return st.acts[bi]; });
    return W;
  }

  /* 给定手动策略，仅求值 */
  function runManualPolicy(p1, policyFn) {
    var W = {};
    var acts = {};
    p1.states.forEach(function (st) {
      acts[st.key] = new Int32Array(st.branches.length);
      for (var bi = 0; bi < st.branches.length; bi++) {
        var view = asView(st.mask, st.labels);
        var ui = 0;
        for (var s = 0; s < 3; s++) {
          if (st.mask & (1 << s)) continue;
          if (p1.fixedMask & (1 << s)) continue;
          view[s] = st.branches[bi].labels[ui++];
        }
        acts[st.key][bi] = policyFn(st, view);
      }
    });
    evalPolicy(p1, W, function (st, bi) { return acts[st.key][bi]; });
    return { W: W, acts: acts };
  }

  /* 任意 (mask, view) 的最优决策（用于行动指南） */
  function makeDecider(p1, W) {
    var model = p1.model;
    return function (mask, view, extraVec) {
      var p2 = phase2Entry(model, view, mask, p1.fixedMask);
      var best = null;
      if (p2 !== null) best = { act: -1, vec: [0, p2[1], p2[2], 0, p2[4]] };
      var cands = p1.candidates(mask, view);
      for (var i = 0; i < cands.length; i++) {
        var act = cands[i];
        var vec;
        if (act === mask) {
          var w0 = W[keyOf(mask, labelsAt(mask, view))];
          if (!w0 || isInf(w0)) continue;
          vec = w0;
        } else {
          var nxt = p1.stateOf(act, labelsAt(act, view));
          if (!nxt || !nxt.feasible) continue;
          var wv = W[nxt.key];
          if (isInf(wv)) continue;
          vec = vadd(wv, [0, 0, p1.lockDelta(mask, act), 0, 0]);
        }
        if (!best || tot(vec) < tot(best.vec)) best = { act: act, vec: vec };
      }
      return best;
    };
  }

  /* =========================================================================
   * 9. 主求解入口
   * ========================================================================= */
  function solve(cfg, start, opts) {
    opts = opts || {};
    var errors = validateConfig(cfg);
    if (errors.length) return { ok: false, errors: errors };

    var t0 = now();
    var model = createModel(cfg);

    start = start || defaultStart();
    var i, s;

    /* ---- 解析初始状态 ---- */
    var inLabels = [ABSENT, ABSENT, ABSENT];
    var inLocked = 0;
    var seen = {};
    for (i = 0; i < 3; i++) {
      var sl = (start.slots && start.slots[i]) || { type: null, tier: 1, locked: false };
      if (!sl.type) continue;
      var ti = -1;
      for (var k = 0; k < model.n; k++) if (model.types[k].id === sl.type) ti = k;
      if (ti < 0) { errors.push('第 ' + (i + 1) + ' 槽位词条无效。'); continue; }
      if (seen[ti] !== undefined) {
        errors.push('第 ' + (i + 1) + ' 槽位与第 ' + (seen[ti] + 1) + ' 槽位设置了相同词条「' +
          model.types[ti].name + '」，游戏中不可能同时存在。');
      }
      seen[ti] = i;
      var tier = Math.max(1, Math.min(TIER_MAX, Math.round(num(sl.tier, 1))));
      inLabels[i] = lab(ti, bandOfTier(model, ti, tier));
      if (sl.locked) inLocked |= (1 << i);
    }
    if (errors.length) return { ok: false, errors: errors };

    /* 初始视图 = 玩家当前真实的三个槽位。
       ⚠ 未锁定的词条同样是「已有的词条」：
          「变更效果」会把未锁定槽位重掷，但「变更数值」只重掷阶数、保留种类，
          所以「种类是否齐备」必须按真实视图判断 —— 否则会出现
          "种类已经齐备、只差阶数，却建议继续洗种类" 的错误结论。
       唯一例外：已锁定 + 非目标词条的槽位视为「永久占用」，不参与任何目标。 */
    var fixedMask = 0, fixedLabels = [ABSENT, ABSENT, ABSENT];
    var dynMask = 0;
    var effectiveLabels = [ABSENT, ABSENT, ABSENT];   // 真正参与求解的初始视图
    for (i = 0; i < 3; i++) {
      if (inLabels[i] === ABSENT) continue;
      effectiveLabels[i] = inLabels[i];
      if (!isTargetLabel(model, inLabels[i])) {
        if (inLocked & (1 << i)) { fixedMask |= (1 << i); fixedLabels[i] = inLabels[i]; }
        continue;
      }
      if (inLocked & (1 << i)) dynMask |= (1 << i);
    }
    var availForReqs = 3 - pc(fixedMask);
    if (model.nReqs > availForReqs) {
      return { ok: false, errors: ['目标条件有 ' + model.nReqs + ' 项，但当前只有 ' + availForReqs +
        ' 个可用槽位（存在已锁定的非目标词条），无法同时满足。'] };
    }

    var p1 = createPhase1(model, fixedMask, fixedLabels, inLocked & dynMask, (function () {
      var arr = [];
      for (var k2 = 0; k2 < 3; k2++) if ((inLocked & dynMask) & (1 << k2)) arr.push(effectiveLabels[k2]);
      return arr;
    })());
    var W = (opts.manual && opts.manual.enabled) ? runManualPolicyFixed(p1, opts.manual) : runPolicyIteration(p1);
    if (opts.manual && opts.manual.enabled) W = W.W;

    var decide = makeDecider(p1, W);

    /* ---- 起始决策：枚举所有可行的"起点锁定组合"方案 ----
       方案空间 = {起点锁哪几个槽}：
         · 视图固定为玩家当前的三个槽位（锁定与否都真实存在）
         · 锁定只影响「变更效果」是否重掷该槽，以及锁定费
       约束：至少要留 1 个未锁定槽位（否则点不了「变更效果」），
             除非三个槽位此刻已经全部达标（0 消耗终态）。 */
    var startViewAll = effectiveLabels.slice();
    var bestStart = null;
    var startOptions = [];

    /* 参与枚举的槽位：非永久锁定（非目标词条锁定）的槽位 */
    var candSlots = [];
    for (i = 0; i < 3; i++) {
      if (fixedMask & (1 << i)) continue;
      candSlots.push(i);
    }

    /* 起始视图与"锁哪几个"无关：当前词条都在场 */
    var startViewFull = (function () {
      var v = [ABSENT, ABSENT, ABSENT];
      for (var k = 0; k < 3; k++) {
        if (fixedMask & (1 << k)) { v[k] = fixedLabels[k]; continue; }
        v[k] = startViewAll[k];
      }
      return v;
    })();

    function viewOfKeep() {
      return startViewFull.slice();
    }

    /* 枚举 keepMask 的所有组合（保持至少 1 个可洗槽位） */
    for (var bi = 0; bi < (1 << candSlots.length); bi++) {
      var keepMask = 0;
      for (var j = 0; j < candSlots.length; j++) if (bi & (1 << j)) keepMask |= (1 << candSlots[j]);
      /* 通常必须至少留 1 个未锁定槽位用于洗练；
         但「三个槽位已经全部达标」是合法终态 —— 一次都不用洗，直接 0 消耗。
         此时全锁组合同样要进入方案空间，否则会误报「无法达成目标」。 */
      var allSlotsLocked = (pc(keepMask) + pc(fixedMask) >= 3);
      /* 必须包含所有已锁定的目标槽位吗？不 —— 允许"解锁"作为一个可选方案（免费） */
      var viewForState = viewOfKeep();
      var dec = decide(keepMask, viewForState);
      if (!dec) continue;
      if (allSlotsLocked && tot(dec.vec) > 1e-9) continue;   // 全锁却还没达标 → 进不了洗练，丢弃
      var keepLabels = [];
      for (var kl = 0; kl < 3; kl++) if (keepMask & (1 << kl)) keepLabels.push(viewForState[kl]);
      var opt = {
        keepMask: keepMask,
        keepLabels: keepLabels,
        keepView: viewForState,
        act: dec.act,
        vec: dec.vec,
        cost: tot(dec.vec),
        unlockSlots: (function () {
          var arr = [];
          for (var u = 0; u < 3; u++) {
            if ((inLocked & (1 << u)) && !(keepMask & (1 << u))) arr.push(u);
          }
          return arr;
        })(),
        newlyLocked: dec.act >= 0 ? (dec.act & ~keepMask) : 0,
        locksCount: pc(keepMask) + pc(fixedMask)
      };
      startOptions.push(opt);
      if (!bestStart || tot(dec.vec) < tot(bestStart.vec)) bestStart = opt;
    }
    if (!bestStart) {
      /* 三个槽位都被锁死时没有任何可洗槽位：这不是"目标无法达成"，而是需要先解锁 */
      if (pc(inLocked) >= 3) {
        return { ok: false, errors: ['三个槽位都已锁定，没有可洗槽位：请至少解锁一个槽位（解锁免费）后再计算。'] };
      }
      return { ok: false, errors: ['当前初始状态下无法达成目标：请检查槽位是否全部被锁定，或目标词条是否可用。'] };
    }

    /* ---- 单次洗练统计 ---- */
    var single = singleRollStats(model, effectiveLabels, inLocked, fixedMask);

    /* ---- 结果 ---- */
    var res = {
      ok: true,
      version: VERSION,
      model: model,
      startLabels: effectiveLabels,      // 参与求解的视图
      inputLabels: inLabels,             // 用户在界面里填写的原始词条
      startLocked: inLocked,
      fixedMask: fixedMask,
      fixedLabels: fixedLabels,
      p1Only: bestStart.act === -1,
      totals: vecTotals(bestStart.vec, model),
      vec: bestStart.vec,
      startOptions: startOptions,
      chosenStart: bestStart,
      single: single,
      elapsedMs: now() - t0,
      states: p1.states.length
    };

    res.guide = buildGuide(model, p1, W, decide, bestStart, startViewAll, fixedMask, fixedLabels, inLocked);
    res.phase2 = buildPhase2Report(model);
    res.elapsedMs = now() - t0;
    res._p1 = p1;
    res._W = W;
    res._decide = decide;
    return res;
  }

  function runManualPolicyFixed(p1, manual) {
    return runManualPolicy(p1, makeManualPolicy(p1, manual));
  }

  function makeManualPolicy(p1, manual) {
    var model = p1.model;
    var order = manual.slotPriority || [2, 1, 0];
    var maxLock = Math.max(0, Math.min(2, Math.round(num(manual.maxLocks, 2))));
    var minBand = Math.max(0, Math.round(num(manual.minBand, 0)));
    return function (st, view) {
      if (manual.enterPhase2 !== false && completeAssignments(model, view).length) return -1;
      var cands = [];
      for (var s = 0; s < 3; s++) {
        if (st.mask & (1 << s)) continue;
        if (p1.fixedMask & (1 << s)) continue;
        var l = view[s];
        if (!isTargetLabel(model, l)) continue;
        if (labBand(l) < minBand) continue;
        cands.push(s);
      }
      cands.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
      var mask = st.mask;
      var cnt = pc(mask) + p1.fixedCount;
      for (var i = 0; i < cands.length && cnt < maxLock; i++) {
        mask |= (1 << cands[i]);
        cnt++;
      }
      if (mask !== st.mask) {
        var nxt = p1.stateOf(mask, labelsAt(mask, view));
        if (!nxt || !nxt.feasible) return st.mask;
      }
      return mask;
    };
  }

  function vecTotals(v, model) {
    return {
      stones: v[0] + v[1] + v[2],
      phase1Stones: v[0],
      phase2Stones: v[1],
      lockStones: v[2],
      phase1Rolls: v[3],
      phase2Rolls: v[4],
      totalRolls: v[3] + v[4],
      raw: v
    };
  }

  /* 非目标词条：统一用 JUNK 表示（与求解器内部一致） */
  function JUNK_OR_UNKNOWN(model, typeIdx) {
    return JUNK;
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /* =========================================================================
   * 10. 单次洗练统计
   * ========================================================================= */
  function singleRollStats(model, labels, lockedMask, fixedMask) {
    var unlocked = [], excl = 0, s;
    for (s = 0; s < 3; s++) {
      if (lockedMask & (1 << s)) excl |= (1 << labType(labels[s]));
      else unlocked.push(s);
    }
    // 非目标锁定槽也要排除（labelType 有效时）
    for (s = 0; s < 3; s++) {
      if ((fixedMask & (1 << s)) && labels[s] !== ABSENT) excl |= (1 << labType(labels[s]));
    }
    var branches = buildBranches(model, unlocked, excl);
    var pTypes = 0, pAll = 0;
    for (var bi = 0; bi < branches.length; bi++) {
      var br = branches[bi], view = labels.slice(), ui = 0;
      for (s = 0; s < 3; s++) {
        if (lockedMask & (1 << s)) continue;
        view[s] = br.labels[ui++];
      }
      var asg = completeAssignments(model, view);
      if (!asg.length) continue;
      pTypes += br.p;
      var done = false;
      for (var ai = 0; ai < asg.length && !done; ai++) {
        var ok = true;
        for (var k2 = 0; k2 < asg[ai].length; k2++) {
          if (!bandSatisfies(model, view[asg[ai][k2].slot], asg[ai][k2].req)) { ok = false; break; }
        }
        if (ok) done = true;
      }
      if (done) pAll += br.p;
    }
    return {
      pTypes: pTypes, pAll: pAll,
      rollCost: model.costs.base + pc(lockedMask) * model.costs.extra,
      unlocked: unlocked
    };
  }

  /* =========================================================================
   * 11. 行动指南
   * ========================================================================= */
  function describeMask(mask, model) {
    var out = [];
    for (var s = 0; s < 3; s++) if (mask & (1 << s)) out.push('第' + (s + 1) + '槽');
    return out.length ? out.join(' + ') : '无锁定';
  }
  function labelName(model, l) {
    if (l === ABSENT) return '空';
    if (l === JUNK) return '非目标词条';
    var t = labType(l);
    if (t < 0 || t >= model.n) return '非目标词条';
    return model.types[t].name;
  }
  function bandDesc(model, l) {
    if (l === ABSENT || l === JUNK) return '';
    var t = labType(l), b = labBand(l);
    var thr = model.thrByType[t];
    if (!thr.length) return '';
    if (b === 0) return '未达 ≥' + thr[0] + '阶';
    return '≥' + thr[b - 1] + '阶' + (b < thr.length ? '(未达≥' + thr[b] + '阶)' : '(达标)');
  }

  function buildGuide(model, p1, W, decide, bestStart, startView, fixedMask, fixedLabels, inLocked) {
    var guide = { start: null, levels: [], phase2: null };
    var s, s2, li, fs;
    W_REF = W;

    /* ---------- 起步 ---------- */
    guide.start = {
      keepMask: bestStart.keepMask,
      unlock: bestStart.unlockSlots || [],
      keepDesc: describeMask(bestStart.keepMask, model),
      lockedDesc: (function () {
        var arr = [];
        for (var k = 0; k < 3; k++) {
          if (inLocked & (1 << k)) arr.push('第' + (k + 1) + '槽');
        }
        return arr.length ? arr.join(' + ') : '无锁定';
      })(),
      act: bestStart.act,
      actionText: (bestStart.act === -1 && tot(bestStart.vec) <= 1e-9)
        ? '目标已全部达成：不用再洗练'
        : (bestStart.act === -1 ? '词条种类已齐备，直接进入「变更数值」阶段' :
          (bestStart.act === bestStart.keepMask
            ? '保持当前锁定（不解锁），点击「变更效果」继续洗种类'
            : '立即锁定 ' + describeMask(bestStart.act & ~bestStart.keepMask, model) + '，再点击「变更效果」')),
      vec: bestStart.vec,
      cost: tot(bestStart.vec)
    };

    /* 每种目标词条列入表格的档位（低阶暂存 / 已达最高档） */
    var labelRows = [];
    for (var ti = 0; ti < model.targetTypes.length; ti++) {
      var t = model.targetTypes[ti];
      for (var bb = 0; bb < model.bandCount[t]; bb++) {
        if (model.bandProbs[t][bb] > 1e-12) labelRows.push(lab(t, bb));
      }
    }

    function baseView() {
      var v = [ABSENT, ABSENT, ABSENT];
      for (var k = 0; k < 3; k++) if (fixedMask & (1 << k)) v[k] = fixedLabels[k];
      return v;
    }

    /* ---------- 第 1 层：让"当前锁定"作为起点走一次决策 ---------- */
    /* 起点的 mask 就是玩家此刻真实锁定的槽位，否则会给出与现状矛盾的建议 */
    var curMask = bestStart.keepMask;
    var curLabels = [];
    for (s = 0; s < 3; s++) if (curMask & (1 << s)) curLabels.push(startView[s]);
    var curBaseDesc = curMask ? describeMask(curMask, model) : '无';

    var level0 = { level: 0, baseMask: curMask, baseLabels: curLabels, rows: [], started: [] };
    for (s = 0; s < 3; s++) {
      if (fixedMask & (1 << s)) continue;
      if (curMask & (1 << s)) continue;       // 已锁定槽位不作为"新出现"参与枚举
      for (li = 0; li < labelRows.length; li++) {
        // 起点视图：已锁定槽位带着自己的词条，其余槽位只有本次枚举的那个有值
        var view = baseView();
        for (var lk = 0; lk < 3; lk++) {
          view[lk] = ABSENT;                       // 未锁定槽位一律从"空"开始
          if (curMask & (1 << lk)) view[lk] = startView[lk];
          if (fixedMask & (1 << lk)) view[lk] = fixedLabels[lk];
        }
        view[s] = labelRows[li];
        var dec = decide(curMask, view);
        if (!dec) continue;
        var row = makeRow(model, p1, 0, curLabels, s, labelRows[li], dec, view, curMask);
        row.baseDesc = curMask ? describeMask(curMask, model) : '';
        row.fromCurrent = true;
        level0.rows.push(row);
        if (dec.act !== -1 && dec.act !== curMask) {
          level0.started.push({ mask: dec.act, slot: s, label: row.label, fromMask: curMask, vec: dec.vec });
        }
      }
    }
    guide.levels.push(level0);

    /* ---------- 1 锁层：展开最优策略真正会进入的锁定状态 ---------- */
    var level1 = { level: 1, rows: [] };
    var emitted = {};                      // 以 (mask, 新出现槽, 词条标签) 三元组去重
    level0.started.sort(function (x, y) { return tot(x.vec) - tot(y.vec); });
    for (var si = 0; si < level0.started.length; si++) {
      var st0 = level0.started[si];
      var sm = st0.mask;
      // 只展开"恰好锁住本次出现的那一个槽位"的状态，且该状态确实是本分支的最优动作
      if (pc(sm) !== 1) continue;
      var smSlot = 0;
      for (s2 = 0; s2 < 3; s2++) if (sm & (1 << s2)) smSlot = s2;
      if (smSlot !== st0.slot) continue;
      for (var s4 = 0; s4 < 3; s4++) {
        if (sm & (1 << s4)) continue;
        if (fixedMask & (1 << s4)) continue;
        for (var lj = 0; lj < labelRows.length; lj++) {
          var dk = sm + '|' + s4 + '|' + labelRows[lj];
          if (emitted[dk]) continue;
          var view1 = baseView();
          view1[smSlot] = st0.label;
          view1[s4] = labelRows[lj];
          var dec1 = decide(sm, view1);
          if (!dec1) continue;
          // 只有"该槽位在最优策略下仍需继续洗种类"才值得列入本层
          if (dec1.act === -1) continue;
          emitted[dk] = 1;
          var row1 = makeRow(model, p1, 1, [st0.label], s4, labelRows[lj], dec1, view1, sm);
          row1.baseDesc = '第' + (smSlot + 1) + '槽「' + labelName(model, st0.label) + '」';
          level1.rows.push(row1);
        }
      }
    }
    if (level1.rows.length) guide.levels.push(level1);

    /* ---------- 阶段二说明 ---------- */
    guide.phase2 = buildPhase2Report(model, startView, bestStart, fixedMask);
    return guide;
  }

  function makeRow(model, p1, level, baseLabels, slot, label, dec, view, baseMask) {
    baseMask = baseMask || 0;
    var lockCost = (dec.act >= 0 && dec.act !== baseMask) ? p1.lockDelta(baseMask, dec.act) : 0;
    // 不锁定（继续洗）的对照成本
    var noLockVec = W_get(p1, W_REF, baseMask, view);
    var row = {
      level: level,
      slot: slot,
      label: label,
      labelName: labelName(model, label),
      bandDesc: bandDesc(model, label),
      baseMask: baseMask,
      baseLabels: baseLabels,
      act: dec.act,
      lock: dec.act !== -1 && dec.act !== baseMask,
      lockSlots: dec.act >= 0 ? (dec.act & ~baseMask) : 0,
      enterPhase2: dec.act === -1,
      cost: tot(dec.vec),
      vec: dec.vec,
      lockCost: lockCost,
      actDesc: dec.act === -1 ? '进入「变更数值」' :
        (dec.act === baseMask ? '不锁定，继续洗种类'
          : '锁定' + describeMask(dec.act & ~baseMask, model) + '，继续洗种类')
    };
    row.delta = (noLockVec && isFinite(tot(noLockVec))) ? (row.cost - tot(noLockVec)) : null;
    return row;
  }

  var W_REF = null;
  function W_get(p1, W, mask, view) {
    if (!W) return null;
    var st = p1.stateOf(mask, labelsAt(mask, view));
    if (!st || !st.feasible) return null;
    var v = W[st.key];
    return (v && !isInf(v)) ? v : null;
  }

  /* 阶段二报告：与初始状态无关，直接按"目标结构"给出洗数值阶段的完整表 */
  function buildPhase2Report(model) {
    var out = { rows: [], assignment: null, applicable: false, n: 0 };

    /* 为每个目标条件挑一个候选种类，并分配到一个槽位（种类互斥） */
    var best = null;
    function pick(r, usedTypes, usedSlots, acc) {
      if (r === model.nReqs) {
        if (!best) best = acc.slice();
        return !!best;
      }
      for (var ci = 0; ci < model.reqs[r].cands.length; ci++) {
        var t = model.reqs[r].cands[ci];
        if (usedTypes[t]) continue;
        for (var s = 0; s < 3; s++) {
          if (usedSlots[s]) continue;
          usedTypes[t] = 1; usedSlots[s] = 1;
          acc.push({ req: r, slot: s, type: t });
          if (pick(r + 1, usedTypes, usedSlots, acc)) return true;
          acc.pop();
          usedTypes[t] = 0; usedSlots[s] = 0;
        }
      }
      return false;
    }
    if (!pick(0, {}, [false, false, false], []) || !best) return out;

    // 分配按 req 排序，与 buildPhase2 的索引约定一致
    best.sort(function (x, y) { return x.req - y.req; });
    var assignment = best.map(function (x) { return { req: x.req, slot: x.slot }; });

    var tbl = buildPhase2(model, assignment, 0);
    out.applicable = true;
    out.assignment = assignment;
    out.types = best.map(function (x) { return x.type; });
    out.n = tbl.n;
    out.full = tbl.full;
    out.entryS = 0;
    /* 报告以「已达标槽位恰好处于最低达标阶数」为基准：这既是新规则下最想保留的
       低数值状态，也给出了最乐观的数值池占用效果。同一件装备数值互不相同，
       所以同门槛的多个槽位依次取更高的阶数。 */
    function valsOfS(S) {
      var v = [0, 0, 0], used = {}, k;
      for (k = 0; k < tbl.n; k++) {
        if (!(S & (1 << k))) continue;
        var tv = tbl.m[k];
        while (used[tv] && tv < 15) tv++;
        used[tv] = 1;
        v[k] = tv;
      }
      for (k = 0; k < tbl.n; k++) {
        if (S & (1 << k)) continue;
        var u = 1;
        while (u < 15 && (used[u] || u >= tbl.m[k])) u++;
        used[u] = 1;
        v[k] = u;
      }
      return v;
    }
    out.entry = tbl.get(0, [0, 0, 0]);
    out.extraLocked = 0;

    for (var S = 0; S <= tbl.full; S++) {
      var vals = valsOfS(S);
      var st = tbl.stats(S, vals);
      var lockNow = tbl.lockSetOf(S);
      var row = {
        S: S,
        L: lockNow,
        satisfied: pc(S),
        need: tbl.n - pc(S),
        perRoll: tbl.toll(pc(S)),
        vec: tbl.get(S, vals),
        probImprove: st.probImprove,
        lockSet: lockNow,
        qs: []
      };
      for (var k2 = 0; k2 < tbl.n; k2++) {
        row.qs.push({
          slot: assignment[k2].slot + 1,
          type: best[k2].type,
          typeName: model.types[best[k2].type].name,
          q: st.q[k2],
          req: assignment[k2].req,
          minTier: model.reqs[assignment[k2].req].minTier,
          inLockSet: !!(lockNow & (1 << k2))
        });
      }
      out.rows.push(row);
    }
    return out;
  }

  /* =========================================================================
   * 12. 蒙特卡洛校验 / 模拟器（仅用于验证，不作为主计算）
   * ========================================================================= */
  function simulate(cfg, start, trials, seed) {
    var errors = validateConfig(cfg);
    if (errors.length) return { ok: false, errors: errors };
    var model = createModel(cfg);
    var sol = solve(cfg, start, {});
    if (!sol.ok) return sol;

    var decide = sol._decide, p1 = sol._p1;
    var fixedMask = sol.fixedMask;
    var rng = mulberry32(seed || 20240607);
    var total = 0, p1stones = 0, p2stones = 0, lockstones = 0, rolls1 = 0, rolls2 = 0, wins = 0, done = 0;
    var T = Math.max(1, Math.min(200000, Math.round(trials || 2000)));
    var tStart = Date.now();

    for (var tt = 0; tt < T; tt++) {
      if (Date.now() - tStart > 2500) break;             // 总时间预算：保证页面不卡死
      var tTrial = Date.now();
      /* 起点必须与"被采纳的起始方案"完全一致：
         选用 keepMask 保留的槽位带着词条进入，其余槽位为空（下一次洗练会被重掷）。 */
      var mask = sol.chosenStart.keepMask;
      var view = (sol.chosenStart.keepView || sol.startLabels).slice();
      var guard = 0;
      /* 单次模拟先在局部累积，只有跑完的样本才计入统计 */
      var cTotal = 0, cP1 = 0, cP2 = 0, cLock = 0, cR1 = 0, cR2 = 0;

      /* ---------- 阶段一：严格按策略 —— 锁定 → 再洗 → 锁定 → ... ---------- */
      while (guard++ < 500) {
        if ((guard & 31) === 0 && Date.now() - tTrial > 200) break;   // 单样本时间预算
        var dec = decide(mask, view);
        if (!dec) break;
        if (dec.act === -1) break;                       // 决策：进入阶段二
        if (pc(mask) >= 3) break;                        // 全锁死：无法再洗，判为未收敛
        if (dec.act !== mask) {                          // 决策：立刻锁定
          var dcost = p1.lockDelta(mask, dec.act);
          cLock += dcost; cTotal += dcost;
          mask = dec.act;
          continue;                                      // 锁定不消耗洗练次数
        }
        var cost = p1.toll(mask);                        // 决策：不锁，洗一次
        cTotal += cost; cP1 += cost; cR1++;
        view = rollEffects(model, view, mask, fixedMask, rng);
      }
      if (guard >= 500) continue;                        // 该样本未收敛，丢弃

      /* ---------- 阶段二：不放回抽数值（达标即锁定） ---------- */
      var asg = completeAssignments(model, view);
      if (!asg.length) continue;

      // 选让当前状态最优的 (分配, 额外锁) —— 与 phase2Entry 一致
      var bestKey = null, bestC = Infinity;
      for (var ai = 0; ai < asg.length; ai++) {
        var a0 = asg[ai], S0 = 0, L0 = 0, used0 = 0, i0;
        var vals0 = [1, 1, 1];
        for (i0 = 0; i0 < a0.length; i0++) {
          used0 |= (1 << a0[i0].slot);
          vals0[i0] = labelTier(model, view[a0[i0].slot]) || 1;
          if (vals0[i0] >= model.reqs[a0[i0].req].minTier) S0 |= (1 << i0);
          if (mask & (1 << a0[i0].slot)) L0 |= (1 << i0);
        }
        L0 = L0 & S0;
        var extra0 = 0;
        for (var s0 = 0; s0 < 3; s0++) if ((fixedMask & (1 << s0)) || ((mask & (1 << s0)) && !(used0 & (1 << s0)))) extra0++;
        var tbl0 = buildPhase2(model, a0, extra0);
        var v0 = tbl0.get(S0, vals0);
        if (isInf(v0)) continue;
        var pay0 = (S0 === (1 << tbl0.n) - 1) ? 0 : lockDeltaCost(model, pc(L0) + extra0, pc(S0) + extra0);
        if (tot(v0) + pay0 < bestC) { bestC = tot(v0) + pay0; bestKey = { asg: a0, tbl: tbl0, extra: extra0 }; }
      }
      if (!bestKey) continue;
      var asg2 = bestKey.asg, tbl2 = bestKey.tbl;

      var tiers = tiersFromView(model, asg2, view), Scur = 0, Lm = 0, slotOf = [];
      for (var i1 = 0; i1 < asg2.length; i1++) {
        slotOf.push(asg2[i1].slot);
        if (tiers[i1] >= tbl2.m[i1]) Scur |= (1 << i1);
      }
      /* 进入阶段二的标准动作：未达标的锁定槽免费解锁；已达标且已锁的沿用 */
      for (i1 = 0; i1 < asg2.length; i1++) {
        var sl0 = slotOf[i1];
        if (Scur & (1 << i1)) { if (mask & (1 << sl0)) Lm |= (1 << i1); }
        else if (mask & (1 << sl0)) mask &= ~(1 << sl0);
      }

      var guard2 = 0;
      while (guard2++ < 5000 && Scur !== tbl2.full) {
        if ((guard2 & 15) === 0 && Date.now() - tTrial > 200) break;  // 单样本时间预算
        // 1) 达标即锁定（按锁定顺序付费）
        for (var i2 = 0; i2 < asg2.length; i2++) {
          if (!(Scur & (1 << i2)) || (Lm & (1 << i2))) continue;
          if (mask & (1 << slotOf[i2])) { Lm |= (1 << i2); continue; }   // 阶段一已锁，无需再付费
          var cnt = 0, s2;
          for (s2 = 0; s2 < 3; s2++) if ((fixedMask & (1 << s2)) || (mask & (1 << s2))) cnt++;
          var lc = model.costs.lock[Math.min(cnt, model.costs.lock.length - 1)];
          cLock += lc; cTotal += lc;
          Lm |= (1 << i2);
          mask |= (1 << slotOf[i2]);
        }
        if (Scur === tbl2.full) break;

        // 2) 洗一次数值：未锁定槽位从「15 阶 − 当前 3 个数值」中不放回抽取
        var c3 = model.costs.base + (pc(mask) + pc(fixedMask)) * model.costs.extra;
        cTotal += c3; cP2 += c3; cR2++;
        var excl = 0, i3;
        for (i3 = 0; i3 < asg2.length; i3++) excl |= (1 << tiers[i3]);   // 当前数值全部占住池子
        /* 某个未达标槽位已经不可能再抽到 ≥ 门槛的数值（池子被占光）→ 放弃本样本 */
        var dead = false;
        for (i3 = 0; i3 < asg2.length && !dead; i3++) {
          if (Lm & (1 << i3)) continue;
          var can = false;
          for (var tt0 = tbl2.m[i3]; tt0 <= 15; tt0++) if (!(excl & (1 << tt0)) && model.tp[tt0 - 1] > 0) { can = true; break; }
          if (!can) dead = true;
        }
        if (dead) break;
        var nv = tiers.slice(), S2 = Scur;
        for (var i4 = 0; i4 < asg2.length; i4++) {
          if (Lm & (1 << i4)) continue;
          var totW = 0, tv;
          for (tv = 1; tv <= 15; tv++) if (!(excl & (1 << tv)) && model.tp[tv - 1] > 0) totW += model.tp[tv - 1];
          var r = rng() * totW, pick = 0;
          for (tv = 1; tv <= 15; tv++) {
            if (excl & (1 << tv)) continue;
            if (model.tp[tv - 1] <= 0) continue;
            r -= model.tp[tv - 1];
            if (r <= 0) { pick = tv; break; }
          }
          if (!pick) {
            for (tv = 15; tv >= 1; tv--) if (!(excl & (1 << tv)) && model.tp[tv - 1] > 0) { pick = tv; break; }
          }
          nv[i4] = pick;
          excl |= (1 << pick);
          if (pick >= tbl2.m[i4]) S2 |= (1 << i4);
        }
        /* 「应用更改」只在有新增达标时才划算，否则「保留当前」 */
        if (S2 !== Scur) {
          tiers = nv;
          Scur = S2;
          for (i4 = 0; i4 < asg2.length; i4++) {
            if (Lm & (1 << i4)) continue;
            view[slotOf[i4]] = lab(labType(view[slotOf[i4]]), bandOfTier(model, labType(view[slotOf[i4]]), tiers[i4]));
          }
        }
      }
      if (Scur !== tbl2.full) continue;                  // 该样本未收敛，丢弃
      total += cTotal; p1stones += cP1; p2stones += cP2;
      lockstones += cLock; rolls1 += cR1; rolls2 += cR2;
      wins++; done++;
    }
    return {
      ok: true, trials: T, wins: wins, done: done,
      avgStones: total / Math.max(1, done), avgPhase1: p1stones / Math.max(1, done), avgPhase2: p2stones / Math.max(1, done),
      avgLock: lockstones / Math.max(1, done), avgRolls1: rolls1 / Math.max(1, done), avgRolls2: rolls2 / Math.max(1, done),
      theory: sol.totals
    };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function rollTier(model, rng) {
    var r = rng(), acc = 0;
    for (var i = 0; i < TIER_MAX; i++) { acc += model.tp[i]; if (r <= acc + 1e-15) return i + 1; }
    return TIER_MAX;
  }

  /* 按真实规则重掷"变更效果" */
  function rollEffects(model, view, mask, fixedMask, rng) {
    var out = view.slice();
    var used = {};
    for (var s = 0; s < 3; s++) {
      if (mask & (1 << s)) { if (view[s] !== ABSENT) used[labType(view[s])] = 1; }
      else if (fixedMask & (1 << s)) { if (view[s] !== ABSENT) used[labType(view[s])] = 1; }
    }
    for (var s2 = 0; s2 < 3; s2++) {
      if (mask & (1 << s2)) continue;
      if (fixedMask & (1 << s2)) continue;
      if (rng() > model.slotP[s2]) { out[s2] = ABSENT; continue; }
      var pool = [], wsum = 0, t;
      for (t = 0; t < model.n; t++) {
        if (used[t]) continue;
        if (model.weights[t] <= 0) continue;
        pool.push(t); wsum += model.weights[t];
      }
      if (!pool.length) { out[s2] = ABSENT; continue; }
      var r = rng() * wsum, pick = pool[pool.length - 1];
      for (var k = 0; k < pool.length; k++) {
        r -= model.weights[pool[k]];
        if (r <= 0) { pick = pool[k]; break; }
      }
      used[pick] = 1;
      var tier = rollTier(model, rng);
      out[s2] = model.isTarget[pick] ? lab(pick, bandOfTier(model, pick, tier)) : JUNK;
    }
    return out;
  }

  /* =========================================================================
   * 13. 导出
   * ========================================================================= */
  return {
    VERSION: VERSION,
    TIER_MAX: TIER_MAX,
    ABSENT: ABSENT,
    JUNK: JUNK,
    TYPE_DEFS: TYPE_DEFS,
    DEFAULT_TIER_PROBS: DEFAULT_TIER_PROBS,
    DEFAULT_SLOT_PROBS: DEFAULT_SLOT_PROBS,
    defaultConfig: defaultConfig,
    defaultStart: defaultStart,
    validateConfig: validateConfig,
    createModel: createModel,
    solve: solve,
    simulate: simulate,
    probGE: probGE,
    tierProb: tierProb,
    bandOfTier: bandOfTier,
    lab: lab,
    labType: labType,
    labBand: labBand,
    buildBranches: buildBranches,
    completeAssignments: completeAssignments,
    buildPhase2: buildPhase2,
    labelTier: labelTier,
    rollEffects: rollEffects,
    bandSatisfies: bandSatisfies,
    typeSatisfies: typeSatisfies,
    labelsAt: labelsAt,
    asView: asView,
    rnd: rnd,
    pc: pc
  };
});
