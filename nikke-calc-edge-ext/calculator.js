// SPDX-License-Identifier: GPL-3.0-or-later
// 计算器界面交互 + Blablalink 角色装备导入与四装备词条汇总联动

import {
  EQUIP_PARTS,
  STORAGE_KEYS,
  openBlablalinkLoginTab,
  storageGet,
  storageSet,
  summarizeCharacterEquipments,
} from "./blablalink-api.js";
import { callApi, ext, openSidePanel } from "./extension-api.js";

(function () {
  "use strict";

  const E = window.NIKKE_ENGINE;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  /* ------------------------------------------------------------------
   * 计算器核心状态（与原版 HTML 保持 100% 一致）
   * ------------------------------------------------------------------ */
  const state = {
    cfg: E.defaultConfig(),
    start: E.defaultStart(),
    manual: { enabled: false, priority: [2, 1, 0], maxLocks: 2, minBand: 0 },
    result: null,
    manualResult: null,
    tab: "pane-guide",
  };

  /* ------------------------------------------------------------------
   * 扩展导入状态
   * ------------------------------------------------------------------ */
  const extState = {
    snapshot: null,
    partMemory: {},
    selectedNameCode: "",
    activePartIndex: 0,
    searchQuery: "",
    onlyWithAffix: true,
    manualMode: false,
    collapsed: false,
  };

  const COST_KEYS = [
    ["base", "基础洗练消耗"],
    ["lock1", "锁第 1 个"],
    ["lock2", "锁第 2 个"],
    ["lock3", "锁第 3 个"],
    ["extra", "每锁 +1/次"],
  ];

  function fmt(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    const v = Number(n);
    if (Math.abs(v) >= 10000) return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return v.toFixed(d === undefined ? 2 : d);
  }
  function pct(n, d) {
    if (!isFinite(n)) return "—";
    const v = n * 100;
    if (v > 0 && v < 0.01) return "<0.01%";
    return v.toFixed(d === undefined ? 2 : d) + "%";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function cloneReqs(reqs) {
    return (Array.isArray(reqs) ? reqs : []).map((r) => ({
      cands: Array.isArray(r.cands) ? r.cands.slice() : [],
      minTier: Math.max(1, Math.min(15, Number(r.minTier) || 1)),
    }));
  }

  function formatSyncTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return "";
    }
  }

  function getTypeDef(typeId) {
    return state.cfg.types.find((t) => t.id === typeId) || null;
  }

  /* ------------------------------------------------------------------
   * 角色导入 & 四部位切换 & 记忆持久化
   * ------------------------------------------------------------------ */
  function isCharacterBound() {
    return Boolean(extState.snapshot && extState.selectedNameCode && !extState.manualMode);
  }

  function memoryKey(nameCode, partIndex) {
    return `${nameCode}:${partIndex}`;
  }

  function getAllCharacters() {
    return Array.isArray(extState.snapshot?.characters) ? extState.snapshot.characters : [];
  }

  function getSelectedCharacter() {
    const code = String(extState.selectedNameCode || "");
    if (!code) return null;
    return getAllCharacters().find((c) => String(c.nameCode) === code) || null;
  }

  function getFilteredCharacters() {
    const list = getAllCharacters();
    const q = extState.searchQuery.trim().toLowerCase();
    return list.filter((c) => {
      if (extState.onlyWithAffix && !(c.affixCount > 0)) return false;
      if (!q) return true;
      return (
        String(c.nameCn || "").toLowerCase().includes(q)
        || String(c.nameTw || "").toLowerCase().includes(q)
        || String(c.nameEn || "").toLowerCase().includes(q)
        || String(c.nameCode || "").toLowerCase().includes(q)
      );
    });
  }

  function partHasMemory(nameCode, partIndex) {
    const mem = extState.partMemory?.[memoryKey(nameCode, partIndex)];
    if (!mem) return false;
    const hasLocked = Array.isArray(mem.slotsLocked) && mem.slotsLocked.some(Boolean);
    const hasReqs = Array.isArray(mem.reqs) && mem.reqs.length > 0;
    return hasLocked || hasReqs;
  }

  let memorySaveTimer = null;
  function captureCurrentPartMemory() {
    if (!isCharacterBound()) return;
    const char = getSelectedCharacter();
    const equip = char?.equipments?.[extState.activePartIndex];
    if (!char || !equip) return;

    const key = memoryKey(char.nameCode, extState.activePartIndex);
    extState.partMemory[key] = {
      slotsLocked: state.start.slots.map((s) => Boolean(s.type && s.locked)),
      slotTypes: (equip.slots || []).map((s) => s?.type || null),
      reqs: cloneReqs(state.cfg.reqs),
      updatedAt: Date.now(),
    };
  }

  function scheduleMemorySave() {
    if (!isCharacterBound()) return;
    captureCurrentPartMemory();
    renderImportHeaderAndCardsOnly();
    clearTimeout(memorySaveTimer);
    memorySaveTimer = setTimeout(() => {
      void storageSet({ [STORAGE_KEYS.PART_MEMORY]: extState.partMemory }, ext);
    }, 180);
  }

  function saveUiPrefs() {
    void storageSet(
      {
        [STORAGE_KEYS.UI_PREFS]: {
          selectedNameCode: extState.selectedNameCode,
          activePartIndex: extState.activePartIndex,
          onlyWithAffix: extState.onlyWithAffix,
          manualMode: extState.manualMode,
          collapsed: extState.collapsed,
        },
      },
      ext
    );
  }

  function applySelectedPartToCalculator({ restoreMemory = true } = {}) {
    const char = getSelectedCharacter();
    if (!char || extState.manualMode) return false;
    const partIdx = Math.max(0, Math.min(3, Number(extState.activePartIndex) || 0));
    extState.activePartIndex = partIdx;
    const equip = char.equipments?.[partIdx];
    const syncedSlots = Array.isArray(equip?.slots) ? equip.slots : [];

    const key = memoryKey(char.nameCode, partIdx);
    const mem = restoreMemory ? extState.partMemory?.[key] : null;
    const currentTypes = [0, 1, 2].map((i) => syncedSlots[i]?.type || null);
    const typesMatch =
      mem
      && (!Array.isArray(mem.slotTypes)
        || mem.slotTypes.every((t, i) => (t || null) === currentTypes[i]));

    for (let i = 0; i < 3; i += 1) {
      const src = syncedSlots[i];
      if (!src || !src.type) {
        state.start.slots[i] = { type: null, tier: 1, locked: false };
      } else {
        const locked = Boolean(typesMatch && mem?.slotsLocked?.[i]);
        state.start.slots[i] = {
          type: src.type,
          tier: Math.max(1, Math.min(15, Number(src.tier) || 1)),
          locked,
        };
      }
    }

    if (typesMatch && Array.isArray(mem?.reqs) && mem.reqs.length > 0) {
      state.cfg.reqs = cloneReqs(mem.reqs);
    }
    return true;
  }

  function selectCharacter(nameCode, { partIndex = 0, recalculate = true } = {}) {
    if (isCharacterBound() && extState.selectedNameCode !== nameCode) {
      captureCurrentPartMemory();
      void storageSet({ [STORAGE_KEYS.PART_MEMORY]: extState.partMemory }, ext);
    }
    extState.selectedNameCode = String(nameCode || "");
    extState.activePartIndex = Math.max(0, Math.min(3, Number(partIndex) || 0));
    if (!extState.manualMode) {
      applySelectedPartToCalculator({ restoreMemory: true });
    }
    saveUiPrefs();
    renderImportPanel();
    if (recalculate) {
      recalc(true);
    }
  }

  function selectEquipmentPart(partIndex) {
    if (!getSelectedCharacter()) return;
    if (isCharacterBound()) {
      captureCurrentPartMemory();
      void storageSet({ [STORAGE_KEYS.PART_MEMORY]: extState.partMemory }, ext);
    }
    extState.activePartIndex = Math.max(0, Math.min(3, Number(partIndex) || 0));
    if (extState.manualMode) {
      extState.manualMode = false;
    }
    applySelectedPartToCalculator({ restoreMemory: true });
    saveUiPrefs();
    renderImportPanel();
    recalc(true);
  }

  function renderImportHeaderAndCardsOnly() {
    const card = $("#importCard");
    const sub = $("#importSub");
    const btnReset = $("#btnResetPart");
    const btnManual = $("#btnManualMode");
    const btnToggle = $("#btnToggleImport");
    const toggleLbl = $("#importToggleLabel");
    const body = $("#importBody");

    if (card) card.classList.toggle("is-collapsed", extState.collapsed);
    if (body) body.hidden = extState.collapsed;
    if (btnToggle) btnToggle.setAttribute("aria-expanded", extState.collapsed ? "false" : "true");
    if (toggleLbl) toggleLbl.textContent = extState.collapsed ? "展开" : "收起";

    if (btnManual) {
      btnManual.setAttribute("aria-pressed", extState.manualMode ? "true" : "false");
      btnManual.classList.toggle("is-active", extState.manualMode);
    }

    const chars = getAllCharacters();
    const char = getSelectedCharacter();
    const hasSnapshot = chars.length > 0;

    if (btnReset) {
      btnReset.hidden = !(hasSnapshot && char && !extState.manualMode);
    }

    if (!hasSnapshot) {
      if (sub) sub.textContent = extState.manualMode ? "纯手动模式（未同步）" : "尚未同步角色数据";
      return;
    }

    if (extState.manualMode) {
      if (sub) sub.textContent = "纯手动模式（已暂停角色联动）";
    } else if (char) {
      const partName = EQUIP_PARTS[extState.activePartIndex]?.name || "头部";
      if (sub) sub.textContent = `当前联动：${char.nameCn} · ${partName}`;
    } else {
      if (sub) sub.textContent = `已同步 ${chars.length} 名角色`;
    }
  }

  function renderImportPanel() {
    const emptyEl = $("#importEmpty");
    const contentEl = $("#importContent");
    const manualBanner = $("#manualModeBanner");
    const accountMeta = $("#accountMeta");
    const charSelect = $("#charSelect");
    const onlyChk = $("#onlyAffixChars");
    const equip4Grid = $("#equip4Grid");
    const affixSummaryGrid = $("#affixSummaryGrid");
    const summaryHint = $("#affixSummaryHint");

    renderImportHeaderAndCardsOnly();

    const chars = getAllCharacters();
    if (!chars.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (contentEl) contentEl.hidden = true;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (contentEl) contentEl.hidden = false;
    if (manualBanner) manualBanner.hidden = !extState.manualMode;
    if (onlyChk) onlyChk.checked = Boolean(extState.onlyWithAffix);

    const acc = extState.snapshot?.account || {};
    const who = acc.roleName ? `${acc.roleName}` : "已同步账号";
    const areaTxt = acc.areaId ? `area:${acc.areaId}` : "";
    const timeTxt = formatSyncTime(extState.snapshot?.updatedAt);
    const metaParts = [who, areaTxt, `${chars.length} 名`, timeTxt].filter(Boolean);
    if (accountMeta) accountMeta.textContent = metaParts.join(" · ");

    const filtered = getFilteredCharacters();
    if (charSelect) {
      if (filtered.length === 0) {
        charSelect.innerHTML = '<option value="">未找到匹配的妮姬</option>';
        charSelect.disabled = true;
      } else {
        charSelect.disabled = false;
        const selectedStillInFiltered = filtered.some(
          (c) => String(c.nameCode) === String(extState.selectedNameCode)
        );
        if (!selectedStillInFiltered && extState.selectedNameCode) {
          const exact = getSelectedCharacter();
          if (exact) filtered.unshift(exact);
        }
        charSelect.innerHTML = filtered
          .map((c) => {
            const label = `${c.nameCn}${c.affixCount ? ` (${c.affixCount}词条)` : " (0词条)"}`;
            const sel = String(c.nameCode) === String(extState.selectedNameCode) ? " selected" : "";
            return `<option value="${esc(c.nameCode)}"${sel}>${esc(label)}</option>`;
          })
          .join("");
      }
    }

    const char = getSelectedCharacter();
    if (!char) {
      if (equip4Grid) equip4Grid.innerHTML = "";
      if (affixSummaryGrid) affixSummaryGrid.innerHTML = "";
      return;
    }

    if (equip4Grid) {
      equip4Grid.innerHTML = EQUIP_PARTS.map((part) => {
        const equip = char.equipments?.[part.index] || {};
        const slots = Array.isArray(equip.slots) ? equip.slots : [];
        const isActive = !extState.manualMode && extState.activePartIndex === part.index;
        const hasMem = partHasMemory(char.nameCode, part.index);
        const lvTxt = equip.equipLv != null ? `Lv.${equip.equipLv}` : "";

        const linesHtml = [0, 1, 2]
          .map((si) => {
            const sl = slots[si];
            if (!sl || !sl.type) {
              return (
                `<div class="equip4-line is-empty">` +
                `<span class="equip4-slot-tag">S${si + 1}</span>` +
                `<span class="equip4-line-name">— 空 —</span>` +
                `</div>`
              );
            }
            const def = getTypeDef(sl.type);
            const tier = Math.max(1, Math.min(15, Number(sl.tier) || 1));
            const val = def?.values?.[tier - 1] ?? 0;
            return (
              `<div class="equip4-line">` +
              `<span class="equip4-slot-tag">S${si + 1}</span>` +
              `<span class="equip4-line-name">${esc(def?.name || sl.type)}</span>` +
              `<span class="tier-pill ${tierClass(tier)}">${tier}阶</span>` +
              `<span class="equip4-line-val">${fmt(val, 2)}%</span>` +
              `</div>`
            );
          })
          .join("");

        return (
          `<button type="button" class="equip4-card${isActive ? " is-active" : ""}" data-part="${part.index}" aria-pressed="${isActive ? "true" : "false"}">` +
          `<div class="equip4-card-h">` +
          `<span class="equip4-part-name">${esc(part.name)}</span>` +
          (lvTxt ? `<span class="equip4-lv">${esc(lvTxt)}</span>` : "") +
          `<span class="equip4-badges">` +
          (hasMem ? `<span class="equip4-badge mem" title="已记忆锁定状态或目标条件">已记忆</span>` : "") +
          (isActive ? `<span class="equip4-badge active">计算中</span>` : "") +
          `</span>` +
          `</div>` +
          `<div class="equip4-lines">${linesHtml}</div>` +
          `</button>`
        );
      }).join("");

      $$("[data-part]", equip4Grid).forEach((btn) => {
        btn.addEventListener("click", () => {
          selectEquipmentPart(Number(btn.getAttribute("data-part")));
        });
      });
    }

    const activeIdxForSummary = extState.manualMode ? -1 : extState.activePartIndex;
    if (summaryHint) {
      summaryHint.textContent = extState.manualMode
        ? "纯手动模式（显示四部位总计）"
        : `高亮 = 当前部位（${EQUIP_PARTS[extState.activePartIndex]?.name || "头部"}）`;
    }

    if (affixSummaryGrid) {
      const summary = summarizeCharacterEquipments(
        char.equipments,
        state.cfg.types,
        activeIdxForSummary
      );
      affixSummaryGrid.innerHTML = summary
        .map((item) => {
          const hasAffix = item.count > 0;
          const partChips = EQUIP_PARTS.map((p, pi) => {
            const t = item.partTiers[pi];
            const isCur = activeIdxForSummary === pi;
            const cls = [
              "affix-part-chip",
              t === null ? "is-empty" : "",
              isCur ? "is-cur" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `<span class="${cls}" title="${esc(p.name)}">${esc(p.shortName)}${t === null ? "—" : t}</span>`;
          }).join("");

          const itemCls = [
            "affix-sum-item",
            hasAffix ? "has-affix" : "is-zero",
            item.inActivePart ? "in-active" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            `<div class="${itemCls}">` +
            `<div class="affix-sum-top">` +
            `<span class="affix-sum-name">${esc(item.name)}</span>` +
            `<span class="affix-sum-count">${item.count} 条</span>` +
            `</div>` +
            `<div class="affix-sum-val">${hasAffix ? `+${fmt(item.totalVal, 2)}%` : "0.00%"}</div>` +
            `<div class="affix-sum-parts">${partChips}</div>` +
            `</div>`
          );
        })
        .join("");
    }
  }

  /* ------------------------------------------------------------------
   * 渲染：槽位
   * ------------------------------------------------------------------ */
  function typeOptions(sel) {
    let out = '<option value="">— 空 / 无词条 —</option>';
    state.cfg.types.forEach(function (t) {
      out += '<option value="' + t.id + '"' + (t.id === sel ? " selected" : "") + ">" + esc(t.name) + "</option>";
    });
    return out;
  }

  function renderSlots() {
    const area = $("#slotArea");
    let html = "";
    for (let i = 0; i < 3; i++) {
      const s = state.start.slots[i];
      const hasType = !!s.type;
      let tl = 1;
      for (let k = 0; k < state.cfg.types.length; k++) {
        if (state.cfg.types[k].id === s.type) tl = state.cfg.types[k].values.length;
      }
      const tier = Math.max(1, Math.min(tl, s.tier || 1));
      let val = 0;
      for (let k2 = 0; k2 < state.cfg.types.length; k2++) {
        if (state.cfg.types[k2].id === s.type) val = state.cfg.types[k2].values[tier - 1];
      }
      let achieved = null, isTarget = false;
      if (hasType) {
        achieved = false;
        state.cfg.reqs.forEach(function (r) {
          if (r.cands.indexOf(s.type) >= 0) {
            isTarget = true;
            if (tier >= (r.minTier || 1)) achieved = true;
          }
        });
      }
      html += '<div class="slot ' + (s.locked ? "locked" : "empty") + '">' +
        '<div class="slot-h">' +
          '<span class="slot-tag">SLOT ' + (i + 1) + "</span>" +
          '<span class="slot-chance">出现率 ' + fmt(state.cfg.slotProbs[i], 0) + "%</span>" +
          '<div class="right">' +
            (hasType ? '<span class="lock-label">锁定</span>' +
              '<label class="switch"><input type="checkbox" data-lock="' + i + '"' + (s.locked ? " checked" : "") + '><span class="slider"></span></label>'
              : "") +
          "</div>" +
        "</div>" +
        '<div class="slot-grid">' +
          "<div>" +
            '<select data-type="' + i + '">' + typeOptions(s.type) + "</select>" +
          "</div>" +
          '<div class="slot-tier">' +
            '<select data-tier="' + i + '"' + (hasType ? "" : " disabled") + ">" +
              (function () {
                let o = "";
                for (let t2 = 1; t2 <= tl; t2++) o += '<option value="' + t2 + '"' + (t2 === tier ? " selected" : "") + ">" + t2 + " 阶</option>";
                return o;
              })() +
            "</select>" +
            (hasType ? '<div class="tier-val">' + fmt(val, 2) + "%</div>" : '<div class="tier-val">—</div>') +
          "</div>" +
        "</div>" +
        (hasType ?
          '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            '<span class="slot-badge ' + (achieved ? "ok" : "no") + '">' +
              (achieved ? "当前阶数已满足目标" : (isTarget ? "未达目标阶数" : "非目标词条")) + "</span>" +
            '<span style="font-size:calc(10.5px + var(--fs-bump));color:var(--txt-3)">' +
              (s.locked ? "已锁定：不会被「变更效果」重掷" : "未锁定：「变更效果」会重掷它，「变更数值」只换阶数") + "</span>" +
          "</div>" : "") +
      "</div>";
    }
    area.innerHTML = html;

    $$("[data-type]", area).forEach(function (el) {
      el.addEventListener("change", function () {
        const i = +el.getAttribute("data-type");
        const old = state.start.slots[i];
        if (!el.value) {
          state.start.slots[i] = { type: null, tier: 1, locked: false };
        } else {
          state.start.slots[i] = { type: el.value, tier: old.tier || 1, locked: old.locked || false };
        }
        recalc();
      });
    });
    $$("[data-tier]", area).forEach(function (el) {
      el.addEventListener("change", function () {
        const i = +el.getAttribute("data-tier");
        state.start.slots[i].tier = +el.value;
        recalc();
      });
    });
    $$("[data-lock]", area).forEach(function (el) {
      el.addEventListener("change", function () {
        const i = +el.getAttribute("data-lock");
        state.start.slots[i].locked = el.checked;
        scheduleMemorySave();
        recalc();
      });
    });
  }

  /* ------------------------------------------------------------------
   * 渲染：目标条件
   * ------------------------------------------------------------------ */
  function renderReqs() {
    const area = $("#reqArea");
    const reqs = state.cfg.reqs;
    let html = "";
    reqs.forEach(function (r, i) {
      let tl = 1;
      r.cands.forEach(function (cid) {
        for (let k = 0; k < state.cfg.types.length; k++) {
          if (state.cfg.types[k].id === cid) tl = state.cfg.types[k].values.length;
        }
      });
      if (!r.cands.length) tl = 15;
      const minT = Math.max(1, Math.min(15, r.minTier || 1));
      html += '<div class="req">' +
        '<div class="req-h">' +
          '<div class="req-idx" title="目标序号，与槽位无关">目标 ' + (i + 1) + "</div>" +
          '<span class="ttl">' + (r.cands.length > 1 ? "多选一（OR）目标" : "固定目标") + "</span>" +
          '<div class="right">' +
            (reqs.length > 1 ? '<button type="button" class="btn ghost sm" data-delreq="' + i + '">删除</button>' : "") +
          "</div>" +
        "</div>" +
        (r.cands.length > 1 ? multiNote(r) : "") +
        '<div class="cands">' +
          state.cfg.types.map(function (t) {
            const on = r.cands.indexOf(t.id) >= 0;
            return '<label class="cand ' + (on ? "on" : "") + '">' +
              '<input type="checkbox" data-cand="' + i + '" data-cid="' + t.id + '"' + (on ? " checked" : "") + ">" +
              '<span class="dot">' + (on ? "✓" : "") + "</span>" + esc(t.name) +
              "</label>";
          }).join("") +
        "</div>" +
        '<div class="req-tier">' +
          '<select data-mintier="' + i + '">' +
            (function () {
              let o = "";
              for (let t2 = 1; t2 <= 15; t2++) {
                o += '<option value="' + t2 + '"' + (t2 === minT ? " selected" : "") + ">" +
                  (t2 === 1 ? "1 阶（不限）" : "≥ " + t2 + " 阶") + "</option>";
              }
              return o;
            })() +
          "</select>" +
          '<span class="tier-preview" id="tprev-' + i + '">' + tierPreview(r, minT) + "</span>" +
        "</div>" +
      "</div>";
    });
    area.innerHTML = html;

    $$("[data-cand]", area).forEach(function (el) {
      el.parentNode.addEventListener("click", function (ev) {
        ev.preventDefault();
        const i = +el.getAttribute("data-cand");
        const cid = el.getAttribute("data-cid");
        const arr = state.cfg.reqs[i].cands;
        const pos = arr.indexOf(cid);
        if (pos >= 0) arr.splice(pos, 1); else arr.push(cid);
        scheduleMemorySave();
        recalc();
      });
    });
    $$("[data-mintier]", area).forEach(function (el) {
      el.addEventListener("change", function () {
        const i = +el.getAttribute("data-mintier");
        state.cfg.reqs[i].minTier = +el.value;
        const pv = $("#tprev-" + i);
        if (pv) pv.innerHTML = tierPreview(state.cfg.reqs[i], +el.value);
        scheduleMemorySave();
        recalc();
      });
    });
    $$("[data-delreq]", area).forEach(function (el) {
      el.addEventListener("click", function () {
        state.cfg.reqs.splice(+el.getAttribute("data-delreq"), 1);
        scheduleMemorySave();
        recalc();
      });
    });
  }

  /* 多选一目标的说明小字 */
  function multiNote(r) {
    const names = r.cands.map(function (cid) {
      for (let k = 0; k < state.cfg.types.length; k++) {
        if (state.cfg.types[k].id === cid) return state.cfg.types[k].name;
      }
      return cid;
    });
    return '<div class="req-multi-note">' +
      '<span class="k">多选一：</span>' +
      '<span class="v">' + esc(names.join(" / ")) + "</span>" +
      "<span>（已选 " + r.cands.length + " 项，命中任意一项即可）</span>" +
      "</div>";
  }

  function tierPreview(r, minTier) {
    if (!r.cands.length) return '<span class="p">未选择词条</span>';
    const out = [];
    r.cands.forEach(function (cid) {
      for (let k = 0; k < state.cfg.types.length; k++) {
        if (state.cfg.types[k].id === cid) {
          out.push('<span class="p">' + esc(state.cfg.types[k].name) + "</span> " +
            fmt(state.cfg.types[k].values[Math.max(0, Math.min(14, minTier - 1))], 2) + "%");
        }
      }
    });
    return out.join(" &nbsp;|&nbsp; ");
  }

  /* ------------------------------------------------------------------
   * 渲染：高级参数
   * ------------------------------------------------------------------ */
  function renderParams() {
    const sp = $("#slotProbArea");
    sp.innerHTML = [0, 1, 2].map(function (i) {
      return "<div>" +
        '<label class="lbl" style="font-size:calc(10.5px + var(--fs-bump))">槽位 ' + (i + 1) + "</label>" +
        '<input type="number" data-slotp="' + i + '" step="1" min="0" max="100" value="' + state.cfg.slotProbs[i] + '">' +
      "</div>";
    }).join("");

    const ca = $("#costArea");
    ca.innerHTML = COST_KEYS.map(function (kv) {
      return "<div>" +
        '<label class="lbl" style="font-size:calc(10.5px + var(--fs-bump))">' + kv[1] + "</label>" +
        '<input type="number" data-cost="' + kv[0] + '" step="1" min="0" value="' + state.cfg.costs[kv[0]] + '">' +
      "</div>";
    }).join("");

    const wa = $("#weightArea");
    wa.innerHTML = state.cfg.types.map(function (t) {
      return '<label style="display:flex;align-items:center;gap:6px;font-size:calc(11.5px + var(--fs-bump))">' +
        '<span style="flex:0 0 88px;color:var(--txt-2)">' + esc(t.name) + "</span>" +
        '<input type="number" data-weight="' + t.id + '" step="1" min="0" max="100" value="' + t.weight + '" style="padding:4px 6px;font-size:calc(11px + var(--fs-bump))">' +
      "</label>";
    }).join("");

    const ta = $("#tierProbArea");
    ta.innerHTML = state.cfg.tierProbs.map(function (p, i) {
      return "<div>" +
        '<label class="lbl" style="font-size:calc(10px + var(--fs-bump));margin-bottom:2px">' + (i + 1) + " 阶</label>" +
        '<input type="number" data-tierp="' + i + '" step="1" min="0" max="100" value="' + p + '" style="padding:4px 6px;font-size:calc(11px + var(--fs-bump))">' +
      "</div>";
    }).join("");

    $$("[data-slotp]").forEach(function (el) {
      el.addEventListener("input", function () {
        state.cfg.slotProbs[+el.getAttribute("data-slotp")] = el.value === "" ? "" : +el.value;
        recalc();
      });
    });
    $$("[data-cost]").forEach(function (el) {
      el.addEventListener("input", function () {
        state.cfg.costs[el.getAttribute("data-cost")] = el.value === "" ? "" : +el.value;
        recalc();
      });
    });
    $$("[data-weight]").forEach(function (el) {
      el.addEventListener("input", function () {
        const id = el.getAttribute("data-weight");
        state.cfg.types.forEach(function (t) { if (t.id === id) t.weight = el.value === "" ? "" : +el.value; });
        recalc();
      });
    });
    $$("[data-tierp]").forEach(function (el) {
      el.addEventListener("input", function () {
        state.cfg.tierProbs[+el.getAttribute("data-tierp")] = el.value === "" ? "" : +el.value;
        recalc();
      });
    });
    updateSums();
  }

  function updateSums() {
    let ws = 0, badW = false;
    state.cfg.types.forEach(function (t) { if (t.weight === "" || !isFinite(t.weight)) badW = true; else ws += +t.weight; });
    let ts = 0, badT = false;
    state.cfg.tierProbs.forEach(function (p) { if (p === "" || !isFinite(p)) badT = true; else ts += +p; });
    const we = $("#weightSum");
    const te = $("#tierSum");
    if (we) we.innerHTML = '当前合计：<b style="color:' + (Math.abs(ws - 100) < 1e-6 && !badW ? "var(--green)" : "var(--red)") + '">' +
      fmt(ws, 2) + "%</b>" + (badW ? " · 存在空值或非法值" : "");
    if (te) te.innerHTML = '当前合计：<b style="color:' + (Math.abs(ts - 100) < 1e-6 && !badT ? "var(--green)" : "var(--red)") + '">' +
      fmt(ts, 2) + "%</b>" + (badT ? " · 存在空值或非法值" : "");
  }

  /* ------------------------------------------------------------------
   * 渲染：手动策略
   * ------------------------------------------------------------------ */
  function renderManual() {
    const pa = $("#prioArea");
    pa.innerHTML = [0, 1, 2].map(function (slot) {
      const pos = state.manual.priority.indexOf(slot);
      return '<div style="flex:1;min-width:0">' +
        '<label class="lbl" style="font-size:calc(10.5px + var(--fs-bump))">槽位 ' + (slot + 1) + "</label>" +
        '<input type="number" data-prio="' + slot + '" min="0" max="2" step="1" value="' + (pos < 0 ? 2 : pos) + '" style="text-align:center">' +
      "</div>";
    }).join("") +
      '<div style="flex:0 0 auto;align-self:flex-end"><span style="font-size:calc(10.5px + var(--fs-bump));color:var(--txt-3)">0 = 最优先</span></div>';

    const mb = $("#manMinBand");
    let opts = '<option value="0">0（低阶也锁）</option>';
    for (let b = 1; b <= 3; b++) opts += '<option value="' + b + '"' + (b === state.manual.minBand ? " selected" : "") + ">" + b + " 级档位</option>";
    mb.innerHTML = opts;
    mb.value = String(state.manual.minBand);

    $$("[data-prio]").forEach(function (el) {
      el.addEventListener("change", function () {
        const slot = +el.getAttribute("data-prio");
        const v = Math.max(0, Math.min(2, +el.value || 0));
        const order = state.manual.priority.slice();
        const old = order.indexOf(slot);
        order.splice(old, 1);
        order.splice(v, 0, slot);
        state.manual.priority = order;
        renderManual();
        recalc();
      });
    });

    $("#manMaxLock").value = String(state.manual.maxLocks);
  }

  /* ------------------------------------------------------------------
   * 校验
   * ------------------------------------------------------------------ */
  function collectErrors() {
    return E.validateConfig(state.cfg);
  }

  function showErrors(errors) {
    const box = $("#globalError");
    if (!errors || !errors.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="notice err">' +
      '<span class="ic">⚠</span><div><strong>参数存在错误，已停止计算</strong>' +
      "<ul>" + errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div></div>";
  }

  /* ------------------------------------------------------------------
   * 计算
   * ------------------------------------------------------------------ */
  let calcTimer = null;
  function recalc(immediate) {
    if (calcTimer) clearTimeout(calcTimer);
    const run = function () {
      renderSlots();
      renderReqs();
      updateSums();
      doCalc();
    };
    if (immediate) run(); else calcTimer = setTimeout(run, 220);
  }

  function doCalc() {
    const errors = collectErrors();
    showErrors(errors);
    if (errors.length) {
      state.result = null;
      state.manualResult = null;
      $("#detailCard").style.display = "none";
      $("#resultArea").innerHTML = '<div class="empty"><div class="big">⚠</div>请先修正上方参数错误</div>';
      $("#resultSub").textContent = "参数错误";
      return;
    }

    let res = null, man = null;
    try {
      res = E.solve(state.cfg, state.start, {});
    } catch (err) {
      $("#resultArea").innerHTML = '<div class="notice err"><span class="ic">⚠</span><div><strong>求解异常</strong>' + esc(err.message) + "</div></div>";
      return;
    }
    if (!res.ok) {
      state.result = null;
      $("#detailCard").style.display = "none";
      $("#resultArea").innerHTML = '<div class="notice err"><span class="ic">⚠</span><div><strong>无法求解</strong><ul>' +
        res.errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div></div>";
      return;
    }

    if (state.manual.enabled) {
      try {
        man = E.solve(state.cfg, state.start, {
          manual: {
            enabled: true,
            slotPriority: state.manual.priority,
            maxLocks: state.manual.maxLocks,
            minBand: state.manual.minBand,
            enterPhase2: true,
          },
        });
      } catch { man = null; }
    }

    state.result = res;
    state.manualResult = man && man.ok ? man : null;
    $("#resultSub").textContent = "最优策略 · " + res.states + " 个状态";

    renderResult(res, state.manualResult);
    $("#detailCard").style.display = "";
    renderGuide(res);
    renderPhase2(res);
    renderManualCompare(res, state.manualResult);
    renderDataTable();
    renderSimulator();
    switchTab(state.tab);
  }

  /* ------------------------------------------------------------------
   * 结果卡片
   * ------------------------------------------------------------------ */
  function renderResult(res, man) {
    const t = res.totals;
    const area = $("#resultArea");
    const total = t.stones || 1;
    const p1w = (t.phase1Stones / total) * 100;
    const p2w = (t.phase2Stones / total) * 100;
    const lkw = (t.lockStones / total) * 100;

    let html = "";

    if (t.stones <= 1e-9) {
      html += '<div class="notice info"><span class="ic">✓</span><div>当前初始状态已满足全部目标条件（词条种类与阶数均达标），<b>无需任何洗练</b>。</div></div>';
    } else if (res.p1Only) {
      html += '<div class="notice info"><span class="ic">ℹ</span><div>三个槽位的<b>词条种类已经覆盖全部目标</b>，只差阶数：' +
        "<b>不需要再点「变更效果」</b>，直接进入「变更数值」阶段把阶数刷上去即可。</div></div>";
    }

    html += '<div class="metrics">' +
      '<div class="metric">' +
        '<div class="k">期望总消耗</div>' +
        '<div class="v">' + fmt(t.stones, 1) + '<span class="u">颗石头</span></div>' +
        '<div class="x">约 ' + fmt(t.totalRolls, 1) + " 次洗练</div>" +
        '<div class="bar">' +
          '<i style="width:' + p1w + '%;background:linear-gradient(90deg,#0052D9,#4582E6)"></i>' +
          '<i style="width:' + p2w + '%;background:linear-gradient(90deg,#E37318,#F0A96B)"></i>' +
          '<i style="width:' + lkw + '%;background:linear-gradient(90deg,#8C8C8C,#BDBDBD)"></i>' +
        "</div>" +
      "</div>" +
      '<div class="metric blue">' +
        '<div class="k">第一阶段 · 洗种类</div>' +
        '<div class="v">' + fmt(t.phase1Stones, 1) + '<span class="u">颗</span></div>' +
        '<div class="x">' + fmt(t.phase1Rolls, 1) + " 次「变更效果」</div>" +
      "</div>" +
      '<div class="metric gold">' +
        '<div class="k">第二阶段 · 洗数值</div>' +
        '<div class="v">' + fmt(t.phase2Stones, 1) + '<span class="u">颗</span></div>' +
        '<div class="x">' + fmt(t.phase2Rolls, 1) + " 次「变更数值」</div>" +
      "</div>" +
      '<div class="metric">' +
        '<div class="k">锁定消耗</div>' +
        '<div class="v">' + fmt(t.lockStones, 1) + '<span class="u">颗</span></div>' +
        '<div class="x">摊到 ' + fmt(t.totalRolls, 1) + " 次洗练</div>" +
      "</div>" +
    "</div>";

    html += '<div class="panel"><h3>初始状态处置 <span class="tag gd">第一步</span></h3>';
    const actions = [];
    (res.chosenStart.unlockSlots || []).forEach(function (s) {
      actions.push("解锁第 " + (s + 1) + " 槽");
    });
    const initAdd = res.chosenStart.initLockSlots || 0;
    if (res.chosenStart.act !== -1 && initAdd) {
      for (let s2 = 0; s2 < 3; s2++) if (initAdd & (1 << s2)) actions.push("锁定第 " + (s2 + 1) + " 槽");
    }
    let actText;
    if (t.stones <= 1e-9) actText = "无需操作：目标已全部达成";
    else if (res.chosenStart.act === -1) actText = "直接进入「变更数值」阶段（洗阶数）";
    else if (actions.length) actText = actions.join(" → ") + " → 点击「变更效果」洗种类";
    else actText = res.startLocked ? "保持当前锁定，洗种类" : "不锁定，直接洗种类";
    html += '<div class="kv"><span class="k">建议动作</span><span class="v cy">' + esc(actText) + "</span></div>";
    if (res.p1Only && t.stones > 1e-9) {
      html += '<div class="kv"><span class="k">词条种类</span><span class="v cy">已全部命中目标，无需洗种类</span></div>';
    }
    html += '<div class="kv"><span class="k">初始已满足的目标</span><span class="v">' + countSatisfied(res) + " / " + state.cfg.reqs.length + "</span></div>";

    const seenPlan = {};
    const opts = (res.startOptions || []).slice()
      .sort(function (a, b) { return a.cost - b.cost; })
      .filter(function (o) {
        const key = o.act + "|" + o.keepMask + "|" + o.cost.toFixed(2);
        if (seenPlan[key]) return false;
        seenPlan[key] = 1;
        return true;
      });
    if (opts.length) {
      html += '<div class="tbl-wrap" style="margin-top:10px;margin-bottom:0"><table class="opts"><thead><tr>' +
        '<th style="width:24px"></th>' +
        "<th>起手方案</th><th>起手锁定</th>" +
        '<th style="text-align:right">期望总消耗</th>' +
        '<th style="text-align:right">洗种类</th>' +
        '<th style="text-align:right">洗数值</th>' +
        '<th style="text-align:right">锁定</th>' +
        "</tr></thead><tbody>";
      opts.forEach(function (o, oi) {
        const isBest = (oi === 0);
        const diff = o.cost - opts[0].cost;
        html += "<tr" + (isBest ? ' class="best"' : "") + ">" +
          '<td class="mid">' + (isBest ? '<span style="color:var(--green);font-weight:900">★</span>' : "") + "</td>" +
          "<td>" + planLabel(o) +
            (isBest ? ' <span class="tag-lock ok">当前最优</span>' : "") +
            (diff > 0.01 ? ' <span style="color:var(--txt-3);font-size:calc(10.5px + var(--fs-bump))">+' + fmt(diff, 1) + "</span>" : "") +
          "</td>" +
          '<td style="font-size:calc(11px + var(--fs-bump))">' + slotEntryDesc(o, res.model) + "</td>" +
          '<td class="num" style="color:' + (isBest ? "var(--cyan-2)" : "var(--txt)") + ';font-weight:800">' + fmt(o.cost, 1) + "</td>" +
          '<td class="num" style="color:var(--txt-2)">' + fmt(o.vec[0], 1) + "</td>" +
          '<td class="num" style="color:var(--txt-2)">' + fmt(o.vec[1], 1) + "</td>" +
          '<td class="num" style="color:var(--txt-2)">' + fmt(o.vec[2], 1) + "</td>" +
          "</tr>";
      });
      html += "</tbody></table></div>";
      html += '<div class="mini-note">' +
        "上表按「起手锁哪几个槽」枚举方案：<b>锁得越多，单次洗练越贵，但已有词条不会被重掷</b>，" +
        "取舍由精确解析解给出。" +
        "</div>";
    }
    html += "</div>";

    if (man) {
      const diff = man.totals.stones - t.stones;
      const pctDiff = t.stones > 0 ? (diff / t.stones) * 100 : 0;
      html += '<div class="notice ' + (diff > 0.01 ? "warn" : "info") + '"><span class="ic">' + (diff > 0.01 ? "⚠" : "✓") + "</span><div>" +
        "<b>手动策略：" + fmt(man.totals.stones, 1) + " 颗</b>　vs　最优策略：" + fmt(t.stones, 1) + " 颗<br>" +
        (diff > 0.01
          ? '你指定的手动策略比最优策略多花 <b style="color:var(--gold-2)">' + fmt(diff, 1) + " 颗石头</b>（+" + fmt(pctDiff, 1) + "%）"
          : (diff < -0.01 ? "手动策略反而更省 " + fmt(-diff, 1) + " 颗（可能最优策略的约束更严格）"
            : "手动策略与最优策略一致")) +
        "</div></div>";
    }

    area.innerHTML = html;
  }

  function slotEntryDesc(opt, model) {
    if (!opt.keepMask) return '<span style="color:var(--txt-3)">不锁任何槽位</span>';
    const parts = [];
    for (let k = 0; k < 3; k++) {
      if (!(opt.keepMask & (1 << k))) continue;
      const lb = (opt.keepView || [])[k];
      let nm = "—", tierTxt = "";
      if (lb && model) {
        const t = Math.floor((lb - 1) / 16);
        if (t >= 0 && t < model.n) nm = model.types[t].name;
        const sl = state.start.slots[k];
        if (sl && sl.type && model.types[t] && model.types[t].id === sl.type) tierTxt = " " + (sl.tier || 1) + "阶";
      }
      parts.push("第" + (k + 1) + "槽「" + nm + tierTxt + "」");
    }
    return "锁定 " + parts.join(" + ") +
      (pcOf(opt.keepMask) >= 3 ? ' → <b style="color:var(--green)">三槽全锁</b>'
        : ' <span style="color:var(--txt-3)">（另 ' + (3 - pcOf(opt.keepMask)) + " 槽可洗）</span>");
  }

  function planLabel(o) {
    if (o.cost <= 1e-9) return "无需操作（目标已达成）";
    if (o.act === -1) return o.initLockSlots ? "先锁住词条，再洗数值" : "直接进入「变更数值」";
    if (o.initLockSlots) return "锁住词条，继续洗种类";
    if (o.unlockSlots && o.unlockSlots.length) return "解锁后继续洗种类";
    return o.keepMask ? "保持锁定，继续洗种类" : "不锁定，直接洗种类";
  }

  function countSatisfied() {
    const slots = [0, 1, 2];
    const reqs = state.cfg.reqs;
    const cand = [];
    for (let r = 0; r < reqs.length; r++) {
      const arr = [];
      for (let i = 0; i < slots.length; i++) {
        const sl = state.start.slots[slots[i]];
        if (!sl || !sl.type) continue;
        if (reqs[r].cands.indexOf(sl.type) >= 0 && (sl.tier || 1) >= (reqs[r].minTier || 1)) arr.push(i);
      }
      cand.push(arr);
    }
    const matchSlot = {};
    let matched = 0;
    function tryAssign(ri, seen) {
      const a = cand[ri];
      for (let k = 0; k < a.length; k++) {
        const si = a[k];
        if (seen[si]) continue;
        seen[si] = 1;
        if (matchSlot[si] === undefined || tryAssign(matchSlot[si], seen)) {
          matchSlot[si] = ri;
          return true;
        }
      }
      return false;
    }
    for (let r2 = 0; r2 < reqs.length; r2++) if (tryAssign(r2, {})) matched++;
    return matched;
  }

  /* ------------------------------------------------------------------
   * 分步行动指南
   * ------------------------------------------------------------------ */
  function slotName(s) { return "第 " + (s + 1) + " 槽"; }
  function pcOf(m) { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; }

  function lockTargets(row) {
    if (!row.lockSlots) return "";
    const parts = [];
    for (let i = 0; i < 3; i++) {
      if (!(row.lockSlots & (1 << i))) continue;
      parts.push(slotName(i));
    }
    return parts.join(" + ");
  }

  function describeMaskSlots(mask) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      if (!(mask & (1 << i))) continue;
      const sl = state.start.slots[i];
      if (!sl || !sl.type) continue;
      let nm = "";
      state.cfg.types.forEach(function (t) { if (t.id === sl.type) nm = t.name; });
      if (!nm) continue;
      out.push("第" + (i + 1) + "槽「" + nm + " " + (sl.tier || 1) + "阶」");
    }
    return out.join("、");
  }

  function describeLockedSlots(res) {
    return describeMaskSlots(res.startLocked);
  }

  function renderGuide(res) {
    const area = $("#pane-guide");
    const g = res.guide;
    let html = "";

    html += '<div class="panel" style="margin-bottom:14px"><h3>策略总览</h3>';
    let step = 1;
    const afterStartMask = (g.start.keepMask | res.fixedMask);
    const startLockChanged = (g.start.act !== -1 && afterStartMask !== res.startLocked);
    html += '<div class="step"><div class="step-n">' + (step++) + '</div><div class="step-c">' +
      '<div class="t">起步：' + esc(g.start.actionText) + "</div>" +
      '<div class="d">当前锁定：<b>' + esc(g.start.lockedDesc || g.start.keepDesc) + "</b>" +
      (startLockChanged ? " → 起手锁定：<b>" + esc(g.start.keepDesc) + "</b>" : "") +
      "　剩余期望：<b>" + fmt(g.start.cost, 1) + "</b> 颗石头</div>" +
      "</div></div>";

    const lv0 = g.levels[0];
    const lockRows0 = lv0.rows.filter(function (r) { return r.lock; });
    const keepRows0 = lv0.rows.filter(function (r) { return !r.lock && !r.enterPhase2; });
    const lockedDesc0 = describeLockedSlots(res);
    const activeMask0 = (lv0.baseMask | res.fixedMask);
    const activeDesc0 = describeMaskSlots(activeMask0);
    const skipPhase1 = (g.start.act === -1);
    const allDone = (res.totals.stones <= 1e-9);

    html += '<div class="step"><div class="step-n">' + (step++) + '</div><div class="step-c">' +
      '<div class="t">阶段一：洗词条种类' + (skipPhase1 ? "（跳过）" : "") + '</div><div class="d">';
    if (allDone) {
      html += "<b>目标已全部达成</b>，阶段一不需要任何操作。<br>";
    } else if (skipPhase1) {
      html += "<b>不需要洗种类</b>：三个槽位当前已经覆盖全部目标种类" +
        (lockedDesc0 ? "（已锁：<b>" + esc(lockedDesc0) + "</b>）" : "（均未锁定，但种类都在场）") +
        "，此时点「变更效果」只会把已经凑齐的种类重掷掉。<br>" +
        '<span style="color:var(--txt-3)">直接跳到阶段二洗阶数即可。</span>';
    } else {
      if (activeDesc0) {
        html += (activeMask0 !== res.startLocked ? "起手已锁：" : "当前已锁：") +
          "<b>" + esc(activeDesc0) + "</b>，这些槽位不会被重洗。<br>";
      }
      if (lockRows0.length) {
        html += "当出现下列目标词条时<b>立即锁定</b>，其余情况继续洗：<br>";
        const bySlot = {};
        lockRows0.forEach(function (r) {
          const k = r.slot + "|" + r.labelName;
          bySlot[k] = r;
        });
        Object.keys(bySlot).forEach(function (k) {
          const r = bySlot[k];
          const lockTxt = lockTargets(r);
          html += "· 在 " + slotName(r.slot) + " 出现「" + esc(r.labelName) + "」" + (r.bandDesc ? "（" + esc(r.bandDesc) + "）" : "") +
            " → <b>锁定 " + esc(lockTxt) + "</b>（花费 " + fmt(r.lockCost, 0) + " 颗），之后剩余期望 <b>" + fmt(r.cost, 1) + "</b> 颗<br>";
        });
      } else if (activeMask0 === 0) {
        html += "在 0 锁状态下，<b>不锁定任何词条</b>直接反复洗练直到种类齐备。<br>";
      } else {
        html += "在其余未锁定槽位上，<b>不需要再追加锁定</b>，继续洗练直到种类齐备即可。<br>";
      }
      if (keepRows0.length) {
        const seenKeep = {};
        const keepTxt = [];
        keepRows0.forEach(function (r) {
          const k = r.slot + "|" + r.labelName + "|" + r.bandDesc;
          if (seenKeep[k]) return;
          seenKeep[k] = 1;
          keepTxt.push(slotName(r.slot) + "「" + esc(r.labelName) + "」" +
            (r.bandDesc ? '<span style="opacity:.75"> ' + esc(r.bandDesc) + "</span>" : ""));
        });
        html += '<span style="color:var(--txt-3)">不锁定（' + keepTxt.length + " 种情形）：" +
          keepTxt.slice(0, 4).join("、") + (keepTxt.length > 4 ? " 等" : "") + "</span>";
      }
    }
    html += "</div></div></div>";

    const needPhase2 = (res.totals.phase2Rolls > 1e-9 || res.totals.phase2Stones > 1e-9);
    html += '<div class="step"><div class="step-n">' + (step++) + '</div><div class="step-c">' +
      '<div class="t">阶段二：单独洗数值' + (skipPhase1 && !allDone ? "（现在就能开始）" : (!needPhase2 && !allDone ? "（无需）" : "")) + "</div>" +
      '<div class="d">' + (allDone
        ? "目标已达成，<b>无需再洗数值</b>。"
        : (skipPhase1
          ? "种类齐备，<b>直接反复点「变更数值」</b>：每次可选择「保留当前」或「应用更改」，仅在出现新达标槽位时应用并锁定。" +
            "该阶段期望共花 <b>" + fmt(res.totals.phase2Stones + res.totals.lockStones, 1) + "</b> 颗石头。"
          : (needPhase2
            ? "种类齐备后，先解锁阶数未达标的槽位，反复点击「变更数值」；每次可「保留当前」以保留低阶数值占位，仅在出现新达标槽位时「应用更改」并锁定。" +
              "洗数值本身期望消耗 <b>" + fmt(res.totals.phase2Stones, 1) + "</b> 颗石头（约 " + fmt(res.totals.phase2Rolls, 1) + " 次，补锁已计入总锁定消耗）。"
            : "所有目标均为 ≥1 阶（不限阶数），词条种类齐备即达成目标，<b>无需进入「变更数值」阶段</b>。"))) +
      "</div></div></div>";
    html += "</div>";

    if (skipPhase1) {
      html += '<div class="mini-note">阶段一被跳过，因此没有「该锁哪个词条」的表格 —— ' +
        "你要做的只有一件事：<b>反复点「变更数值」</b>，直到三个槽位的阶数都达标。" +
        "每次可先选「保留当前」保留低阶占位，仅在出现新达标槽位时「应用更改」并锁定，具体取舍见「数值洗练阶段」页。</div>";
      area.innerHTML = html;
      return;
    }

    g.levels.forEach(function (lv) {
      const rows = lv.rows;
      if (!rows.length) return;
      const lockRows = rows.filter(function (r) { return r.lock || r.enterPhase2; });
      const show = lockRows.length ? lockRows : rows;
      const everyDone = rows.length > 0 && rows.every(function (r) { return r.cost <= 1e-9; });
      const lv0Mask = (lv.baseMask | res.fixedMask);
      const lv0Title = lv0Mask
        ? ((lv0Mask !== res.startLocked ? "第 1 步 · 起手锁定后（已锁 " : "第 1 步 · 当前状态（已锁 ") + pcOf(lv0Mask) + " 个）")
        : "第 1 步 · 0 锁状态";
      const lv0Badge = (lv.level === 0 && lv0Mask) ? describeMaskSlots(lv0Mask) : "";
      html += '<div class="panel" style="margin-bottom:14px">' +
        "<h3>" + (lv.level === 0
          ? lv0Title
          : "第 2 步 · 已锁 " + lv.level + " 个目标词条") +
        ' <span class="tag">该锁就锁</span>' +
        (lv.level === 0 && lv0Badge ? ' <span style="color:var(--gold-2);font-size:calc(11px + var(--fs-bump));font-weight:600">已锁：' + esc(lv0Badge) + "</span>" : "") +
        (lv.level > 0 && lv.rows[0] && lv.rows[0].baseDesc ? ' <span style="color:var(--gold-2);font-size:calc(11px + var(--fs-bump));font-weight:600">当前已锁：' + esc(lv.rows[0].baseDesc) + "</span>" : "") +
        "</h3>" +
        '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>出现位置</th><th>出现的词条</th><th>阶数状态</th><th>建议动作</th><th style="text-align:right">锁定花费</th><th style="text-align:right">该步后期望剩余</th>' +
        "</tr></thead><tbody>";

      const sorted = show.slice().sort(function (a, b) {
        if (a.slot !== b.slot) return a.slot - b.slot;
        return a.cost - b.cost;
      });
      sorted.forEach(function (r) {
        html += "<tr>" +
          '<td><b style="color:var(--cyan-2)">' + slotName(r.slot) + "</b></td>" +
          "<td>" + esc(r.labelName) + "</td>" +
          '<td style="color:var(--txt-2);font-size:calc(11px + var(--fs-bump) + 1px)">' + esc(r.bandDesc || "—") + "</td>" +
          '<td><span class="tag-lock ' + (r.cost <= 1e-9 ? "ok" : (r.enterPhase2 ? "p2" : (r.lock ? "yes" : "no"))) + '">' +
            (r.cost <= 1e-9 ? "目标已达成" : (r.enterPhase2 ? "进入数值阶段" : (r.lock ? "锁定" : "不锁，继续洗"))) + "</span>" +
            (r.lockSlots ? ' <span style="color:var(--txt-2);font-size:calc(11px + var(--fs-bump))">→ ' +
              esc(lockTargets(r)) + "</span>" : "") +
          "</td>" +
          '<td class="num" style="color:var(--gold-2)">' + (r.lockCost ? fmt(r.lockCost, 0) : "—") + "</td>" +
          '<td class="num" style="color:var(--cyan-2)">' + fmt(r.cost, 1) + "</td>" +
          "</tr>";
      });
      html += "</tbody></table></div>";
      const nLockActual = rows.filter(function (r) { return r.lock; }).length;
      if (everyDone) {
        html += '<div class="mini-note"><b style="color:var(--green)">该状态下目标已全部达成</b>，' +
          "无需继续洗练，因此这里没有可执行的锁定动作。</div>";
      } else if (!nLockActual) {
        html += '<div class="mini-note"><b style="color:var(--gold-2)">为什么这里没有「锁定」建议？</b> ' +
          "在这个状态下，把新洗出的词条锁住要额外付锁定费，而锁定后并不能减少剩余的洗练次数，" +
          "所以<b>不锁、直接继续洗</b>反而更省石头。只有当锁定能显著提高达成概率时才值得锁。</div>";
      } else if (lockRows.length < rows.length) {
        html += '<div class="mini-note">表中仅列出需要「锁定」或「进入数值阶段」的关键情形；其余 ' +
          (rows.length - lockRows.length) + " 种情形均<b>不锁定</b>、直接继续洗练。</div>";
      }
      html += "</div>";
    });

    area.innerHTML = html;
  }

  /* ------------------------------------------------------------------
   * 数值洗练阶段
   * ------------------------------------------------------------------ */
  function renderPhase2(res) {
    const area = $("#pane-p2");
    const p2 = res.phase2;
    let html = "";

    html += '<div class="panel" style="margin-bottom:14px"><h3>阶段二规则 <span class="tag gd">变更数值</span></h3>' +
      '<div class="step"><div class="step-n">1</div><div class="step-c">' +
        '<div class="t">词条种类与槽位全部保留</div>' +
        '<div class="d">每次「变更数值」<b>不会改变种类、也不会让槽位消失</b>，只会重掷<b>未锁定</b>槽位的阶数。' +
        "因此为保种类而锁住的低阶目标词条，在这里要<b>先解锁</b>才能重刷。</div>" +
      "</div></div>" +
      '<div class="step"><div class="step-n">2</div><div class="step-c">' +
        '<div class="t">保留当前 / 应用更改：低阶数值会一直占着池子</div>' +
        '<div class="d">每次「变更数值」会先给出新数值，你可以<b>保留当前</b>（什么都不变，只付一次洗练费）' +
        "或<b>应用更改</b>。同一件装备上<b>不会出现两个相同数值</b>，所以当前这 3 个数值始终把对应档位挡在池外，" +
        "未锁定槽位只能从剩下的 12 个阶数里不放回抽取。<br>" +
        "由此得到一条反直觉但确实更省的打法：<b>先留着低阶（出现率 12% 等）的数值不换</b>，" +
        "等于把最常见的高概率档位永久移出池子，其余槽位抽到高阶的概率随之变高；" +
        "而占着一个 15 阶（1%）反而会把稀有的高阶挡掉。</div>" +
      "</div></div>" +
      '<div class="step"><div class="step-n">3</div><div class="step-c">' +
        '<div class="t">只在「出现目标阶数」时才应用并锁定</div>' +
        '<div class="d">保留当前<b>不需要付锁定费</b>；只有当新数值带来新的达标槽位时才「应用更改」，' +
        "此时才按顺序支付锁定石头把达标槽位锁住，之后它不再参与重掷、并继续占用数值池。</div>" +
      "</div></div>" +
      '<div class="step"><div class="step-n">4</div><div class="step-c">' +
        '<div class="t">每次成本 = 基础消耗 + 已锁定数 × 额外消耗</div>' +
        '<div class="d">锁 0 个每次 ' + fmt(state.cfg.costs.base, 0) + " 颗，锁 1 个每次 " +
        fmt(+state.cfg.costs.base + +state.cfg.costs.extra, 0) + " 颗，锁 2 个每次 " +
        fmt(+state.cfg.costs.base + 2 * +state.cfg.costs.extra, 0) + " 颗。</div>" +
      "</div></div>" +
      "</div>";

    if (p2 && p2.applicable && p2.rows.length) {
      html += '<div class="panel" style="margin-bottom:14px"><h3>你的目标在「变更数值」阶段 <span class="tag">精确解析解</span></h3>' +
        '<div class="mini-note" style="margin-bottom:9px">' +
        "阶段二只看「词条种类 + 阶数」，与它出现在第几槽无关。你的目标对应：" +
        p2.rows[0].qs.map(function (q) {
          return "目标 " + (q.req + 1) + "「" + esc(q.typeName) + "」需 ≥" + q.minTier + " 阶（单次达标率 " + pct(q.q, 2) + "）";
        }).join("，") + "。</div>" +
        '<div class="tbl-wrap"><table><thead><tr>' +
        "<th>已达标槽位数</th><th>仍需达标</th><th>本轮至少提升一个的概率</th><th>单次成本</th>" +
        '<th style="text-align:right">剩余期望（洗数值）</th><th style="text-align:right">剩余期望（含补锁）</th>' +
        "</tr></thead><tbody>";
      p2.rows.slice().sort(function (x, y) { return y.satisfied - x.satisfied; }).forEach(function (r) {
        if (r.need === 0) return;
        html += "<tr>" +
          '<td class="mid"><span class="tier-pill ' + tierClass(r.satisfied + 1) + '">' + r.satisfied + " / " + p2.n + "</span></td>" +
          '<td class="mid">' + r.need + "</td>" +
          '<td class="num">' + (r.need > 0 ? pct(r.probImprove, 2) : "—") + "</td>" +
          '<td class="num">' + (r.need > 0 ? fmt(r.perRoll, 0) + " 颗" : "—") + "</td>" +
          '<td class="num" style="color:var(--cyan-2)">' + (r.need > 0 ? fmt(r.vec[1], 1) : "0") + "</td>" +
          '<td class="num" style="color:var(--gold-2)">' + (r.need > 0 ? fmt(r.vec[1] + r.vec[2], 1) : "0") + "</td>" +
          "</tr>";
      });
      html += "</tbody></table></div>" +
        '<div class="mini-note">「已达标槽位数」指该槽位阶数已满足最低要求；表内按<b>已达标槽位恰好停在其最低达标阶数</b>估算' +
        "（这既是新规则下最想保留的低数值状态，也让数值池的占用效果最好）。" +
        "锁住的数值会退出抽取池，所以「先留存低数值词条」在这里会直接体现在剩余期望上。</div></div>";
    }

    html += buildSingleSlotTierTable(res.model);

    area.innerHTML = html;
  }

  function tierClass(t) {
    if (t >= 15) return "tier-top";
    if (t >= 13) return "tier-5";
    if (t >= 12) return "tier-4";
    if (t >= 8) return "tier-3";
    if (t >= 4) return "tier-2";
    return "tier-1";
  }

  function buildSingleSlotTierTable(model) {
    let html = '<div class="panel"><h3>单槽洗数值达标概率 <span class="tag gd">通用速查</span></h3>' +
      '<div class="tbl-wrap"><table><thead><tr><th>最低阶数要求</th><th>单次洗练达标概率</th><th>期望洗练次数</th>' +
      "<th>1 个槽位</th><th>2 个槽位</th><th>3 个槽位</th></tr></thead><tbody>";
    for (let t = 1; t <= 15; t++) {
      const q = E.probGE(model, t);
      const e1 = q > 0 ? 1 / q : Infinity;
      const p2 = 1 - Math.pow(1 - q, 2);
      const p3 = 1 - Math.pow(1 - q, 3);
      const e2 = p2 > 0 ? 1 / p2 : Infinity;
      const e3 = p3 > 0 ? 1 / p3 : Infinity;
      html += "<tr>" +
        '<td class="mid"><span class="tier-pill ' + tierClass(t) + '">≥ ' + t + " 阶</span></td>" +
        '<td class="num">' + pct(q, 2) + "</td>" +
        '<td class="num">' + (q > 0 ? fmt(1 / q, 2) : "∞") + "</td>" +
        '<td class="num" style="color:var(--cyan-2)">' + (q > 0 ? fmt(e1, 2) : "∞") + "</td>" +
        '<td class="num" style="color:var(--cyan-2)">' + (p2 > 0 ? fmt(e2, 2) : "∞") + "</td>" +
        '<td class="num" style="color:var(--cyan-2)">' + (p3 > 0 ? fmt(e3, 2) : "∞") + "</td>" +
        "</tr>";
    }
    html += "</tbody></table></div>" +
      '<div class="mini-note">右三列为「n 个独立槽位同时洗，直到<b>至少 1 个</b>达标」的期望次数：' +
      "E = 1 / (1 − (1−q)^n)（单槽独立近似，未计同装备数值唯一性；完整多槽精确解析解见上方表格）。</div></div>";
    return html;
  }

  /* ------------------------------------------------------------------
   * 手动策略对比
   * ------------------------------------------------------------------ */
  function renderManualCompare(opt, man) {
    const area = $("#pane-manual");
    if (!state.manual.enabled) {
      area.innerHTML = '<div class="notice info"><span class="ic">ℹ</span><div>' +
        "左侧「手动策略对比」开关尚未启用。启用后可以指定槽位锁定优先级，" +
        "并看到该策略与最优策略的石头消耗差距。</div></div>" +
        '<div class="panel"><h3>最优策略基准</h3>' +
        '<div class="kv"><span class="k">期望总消耗</span><span class="v cy">' + fmt(opt.totals.stones, 1) + " 颗</span></div>" +
        '<div class="kv"><span class="k">第一阶段</span><span class="v">' + fmt(opt.totals.phase1Stones, 1) + " 颗 / " + fmt(opt.totals.phase1Rolls, 1) + " 次</span></div>" +
        '<div class="kv"><span class="k">第二阶段</span><span class="v">' + fmt(opt.totals.phase2Stones, 1) + " 颗 / " + fmt(opt.totals.phase2Rolls, 1) + " 次</span></div>" +
        '<div class="kv"><span class="k">锁定消耗</span><span class="v">' + fmt(opt.totals.lockStones, 1) + " 颗</span></div>" +
        "</div>";
      return;
    }
    if (!man) {
      area.innerHTML = '<div class="notice warn"><span class="ic">⚠</span><div>当前手动策略设置无法达成目标，或求解失败。</div></div>';
      return;
    }
    const diff = man.totals.stones - opt.totals.stones;
    const pctD = opt.totals.stones > 0 ? (diff / opt.totals.stones) * 100 : 0;
    let html = '<div class="metrics" style="margin-bottom:14px">' +
      '<div class="metric"><div class="k">最优策略</div><div class="v">' + fmt(opt.totals.stones, 1) +
        '<span class="u">颗</span></div><div class="x">' + fmt(opt.totals.totalRolls, 1) + " 次洗练</div></div>" +
      '<div class="metric ' + (diff > 0.01 ? "gold" : "blue") + '"><div class="k">手动策略</div><div class="v">' + fmt(man.totals.stones, 1) +
        '<span class="u">颗</span></div><div class="x">' + fmt(man.totals.totalRolls, 1) + " 次洗练</div></div>" +
      '<div class="metric ' + (diff > 0.01 ? "gold" : "blue") + '"><div class="k">差值</div><div class="v">' +
        (diff > 0.01 ? "+" : "") + fmt(diff, 1) + '<span class="u">颗</span></div><div class="x">' +
        (diff > 0.01 ? "+" : "") + fmt(pctD, 1) + "%</div></div>" +
      "</div>";

    html += '<div class="panel"><h3>分项对比</h3><div class="tbl-wrap"><table><thead><tr>' +
      '<th>项目</th><th style="text-align:right">最优策略</th><th style="text-align:right">手动策略</th><th style="text-align:right">差值</th>' +
      "</tr></thead><tbody>";
    const rows = [
      ["第一阶段洗种类", opt.totals.phase1Stones, man.totals.phase1Stones, "颗"],
      ["第二阶段洗数值", opt.totals.phase2Stones, man.totals.phase2Stones, "颗"],
      ["锁定消耗", opt.totals.lockStones, man.totals.lockStones, "颗"],
      ["洗练次数（阶段一）", opt.totals.phase1Rolls, man.totals.phase1Rolls, "次"],
      ["洗练次数（阶段二）", opt.totals.phase2Rolls, man.totals.phase2Rolls, "次"],
      ["<b>总石头</b>", opt.totals.stones, man.totals.stones, "颗"],
    ];
    rows.forEach(function (r) {
      const d = r[2] - r[1];
      html += "<tr><td>" + r[0] + "</td>" +
        '<td class="num" style="color:var(--cyan-2)">' + fmt(r[1], 2) + "</td>" +
        '<td class="num" style="color:var(--gold-2)">' + fmt(r[2], 2) + "</td>" +
        '<td class="num" style="color:' + (d > 0.01 ? "var(--red)" : (d < -0.01 ? "var(--green)" : "var(--txt-3)")) + '">' +
        (d > 0.01 ? "+" : "") + fmt(d, 2) + " " + r[3] + "</td></tr>";
    });
    html += "</tbody></table></div></div>";

    const prio = state.manual.priority.map(function (x) { return "槽位" + (x + 1); }).join(" > ");
    html += '<div class="panel" style="margin-top:14px"><h3>当前手动规则</h3>' +
      '<div class="kv"><span class="k">锁定优先级</span><span class="v">' + esc(prio) + "</span></div>" +
      '<div class="kv"><span class="k">最多同时锁定</span><span class="v">' + state.manual.maxLocks + " 个</span></div>" +
      '<div class="kv"><span class="k">最低锁定档位</span><span class="v">' +
        (state.manual.minBand === 0 ? "低阶也锁" : "需达到 " + state.manual.minBand + " 级档位") + "</span></div>" +
      "</div>";

    area.innerHTML = html;
  }

  /* ------------------------------------------------------------------
   * 数值总表（1~15 阶 × 9 词条）
   * ------------------------------------------------------------------ */
  function renderDataTable() {
    const area = $("#pane-data");
    let html = '<div class="panel"><h3>词条数值总表 <span class="tag">1 ~ 15 阶</span></h3>' +
      '<div class="mini-note" style="margin-bottom:9px">12 阶以上以蓝/黑底色高亮。表格第一列为出现权重，最下方为各阶出现概率。</div>' +
      '<div class="tbl-wrap"><table class="matrix"><thead><tr><th style="text-align:left">词条 \\ 阶数</th>' +
      "<th>权重</th>";
    for (let t = 1; t <= 15; t++) html += "<th>" + t + "</th>";
    html += "</tr></thead><tbody>";
    state.cfg.types.forEach(function (ty) {
      html += '<tr><td class="nm">' + esc(ty.name) + "</td>" +
        '<td class="mid" style="color:var(--gold-2);font-family:var(--mono)">' + fmt(ty.weight, 0) + "%</td>";
      ty.values.forEach(function (v, i) {
        const tier = i + 1;
        const cls = tier >= 15 ? "tier-top" : (tier >= 13 ? "tier-5" : (tier >= 12 ? "tier-4" : ""));
        html += '<td class="mid"><span class="' + (cls ? "tier-pill " + cls : "") + '" style="' +
          (cls ? "" : "color:var(--txt-2)") + '">' + fmt(v, 2) + "</span></td>";
      });
      html += "</tr>";
    });
    html += '<tr><td class="nm" style="color:var(--cyan-2)">出现概率</td><td class="mid">100%</td>';
    for (let t2 = 0; t2 < 15; t2++) {
      html += '<td class="mid" style="font-family:var(--mono);color:var(--txt-2)">' + fmt(state.cfg.tierProbs[t2], 0) + "%</td>";
    }
    html += "</tr></tbody></table></div></div>";

    html += (state.result ? buildSingleSlotTierTable(state.result.model) : "");
    area.innerHTML = html;
  }

  /* ------------------------------------------------------------------
   * 模拟器
   * ------------------------------------------------------------------ */
  function renderSimulator() {
    const area = $("#pane-sim");
    if (!document.getElementById("simRun")) {
      area.innerHTML = '<div class="panel"><h3>模拟洗练测试器 <span class="tag gd">仅供娱乐 / 交叉验证</span></h3>' +
        '<div class="mini-note" style="margin-bottom:10px">' +
        "用你当前的参数和<b>最优策略</b>真实跑一遍随机洗练，观察实付石头是否贴近理论期望。" +
        "随机模拟有波动，多跑几次取平均；<b>核心结果仍以上方精确解析解为准</b>。</div>" +
        '<div class="row" style="margin-bottom:10px">' +
          '<select id="simRuns" style="width:auto">' +
            '<option value="1000">1,000 次</option>' +
            '<option value="5000" selected>5,000 次</option>' +
            '<option value="20000">20,000 次</option>' +
            '<option value="50000">50,000 次</option>' +
          "</select>" +
          '<button type="button" class="btn primary" id="simRun">▶ 开始模拟</button>' +
        "</div>" +
        '<div class="progress"><i id="simBar"></i></div>' +
        '<div class="sim-out" id="simOut"><span class="dim">尚未模拟。点击上方按钮开始。</span></div>' +
        "</div>";

      $("#simRun").addEventListener("click", function () {
        const btn = this;
        const runs = +$("#simRuns").value;
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> 模拟中…';
        $("#simOut").innerHTML = '<span class="dim">正在跑 ' + runs.toLocaleString() + " 次模拟…</span>";
        const bar = $("#simBar");
        bar.style.width = "8%";
        setTimeout(function () {
          const t0 = performance.now();
          let out;
          try {
            out = E.simulate(state.cfg, state.start, runs, (Date.now() % 100000) | 1);
          } catch (e) {
            out = { ok: false, errors: [e.message] };
          }
          const ms = performance.now() - t0;
          bar.style.width = "100%";
          btn.disabled = false;
          btn.textContent = "▶ 再次模拟";
          if (!out.ok) {
            $("#simOut").innerHTML = '<span class="warn">模拟失败：' + esc((out.errors || []).join("；")) + "</span>";
            return;
          }
          const th = out.theory;
          const sim = out.avgStones;
          const dev = th.stones > 0 ? ((sim / th.stones - 1) * 100) : 0;
          const lines = [];
          lines.push('<span class="cy">模拟 ' + out.trials.toLocaleString() + ' 次</span> <span class="dim">耗时 ' + ms.toFixed(0) + " ms</span>");
          lines.push("");
          lines.push('平均总石头      : <span class="ok">' + sim.toFixed(2) + '</span>   <span class="dim">理论 ' + th.stones.toFixed(2) + "</span>");
          lines.push("  阶段洗种类    : " + out.avgPhase1.toFixed(2) + '   <span class="dim">理论 ' + th.phase1Stones.toFixed(2) + "</span>");
          lines.push("  阶段洗数值    : " + out.avgPhase2.toFixed(2) + '   <span class="dim">理论 ' + th.phase2Stones.toFixed(2) + "</span>");
          lines.push("  锁定消耗      : " + out.avgLock.toFixed(2) + '   <span class="dim">理论 ' + th.lockStones.toFixed(2) + "</span>");
          lines.push("");
          lines.push("平均洗练次数    : " + (out.avgRolls1 + out.avgRolls2).toFixed(2) + '   <span class="dim">理论 ' + th.totalRolls.toFixed(2) + "</span>");
          lines.push("  阶段一        : " + out.avgRolls1.toFixed(2) + '   <span class="dim">理论 ' + th.phase1Rolls.toFixed(2) + "</span>");
          lines.push("  阶段二        : " + out.avgRolls2.toFixed(2) + '   <span class="dim">理论 ' + th.phase2Rolls.toFixed(2) + "</span>");
          lines.push("");
          const good = Math.abs(dev) < 3;
          lines.push('偏差           : <span class="' + (good ? "ok" : "warn") + '">' + (dev > 0 ? "+" : "") + dev.toFixed(2) + "%</span>" +
            (good ? '  <span class="ok">✓ 与解析解吻合</span>' : '  <span class="dim">（随机波动，可多跑几次）</span>'));
          $("#simOut").innerHTML = lines.join("\n");
        }, 40);
      });
      return;
    }
    const out = $("#simOut");
    if (out && /正在跑/.test(out.textContent)) return;
  }

  /* ------------------------------------------------------------------
   * Tab 切换
   * ------------------------------------------------------------------ */
  function switchTab(id) {
    state.tab = id;
    $$("#tabs .tab").forEach(function (t) {
      t.classList.toggle("on", t.getAttribute("data-pane") === id);
    });
    $$(".tabpane").forEach(function (p) {
      p.classList.toggle("on", p.id === id);
    });
  }

  /* ------------------------------------------------------------------
   * 预设
   * ------------------------------------------------------------------ */
  function applyPresetReqs(rawReqs) {
    state.cfg.reqs = rawReqs.map(function (r) {
      return { cands: r.cands.slice(), minTier: r.minTier };
    });
  }

  const PRESETS = [
    {
      name: "攻优弹",
      short: "攻优弹",
      desc: "攻击力 + 优越代码伤害 + 最大装弹数（任意槽位命中即算）",
      icon: "⚔",
      apply: function () {
        applyPresetReqs([
          { cands: ["atk"], minTier: 1 },
          { cands: ["elite"], minTier: 1 },
          { cands: ["ammo"], minTier: 1 },
        ]);
      },
    },
    {
      name: "攻优弹（≥11 阶）",
      short: "攻优弹 ≥11",
      desc: "三条都要求 ≥11 阶，会大量进入洗数值阶段（任意槽位命中即算）",
      icon: "▲",
      apply: function () {
        applyPresetReqs([
          { cands: ["atk"], minTier: 11 },
          { cands: ["elite"], minTier: 11 },
          { cands: ["ammo"], minTier: 11 },
        ]);
      },
    },
    {
      name: "攻优 + 三选一",
      short: "攻优 + 三选一",
      desc: "攻击 + 优；第三条接受 暴伤/暴击/弹容 任一，出现在任意槽位都算",
      icon: "✦",
      apply: function () {
        applyPresetReqs([
          { cands: ["atk"], minTier: 1 },
          { cands: ["elite"], minTier: 1 },
          { cands: ["cdmg", "crit", "ammo"], minTier: 1 },
        ]);
      },
    },
    {
      name: "攻优（≥11 阶）+ 三选一（≥7 阶）",
      short: "攻优 ≥11 + 三选一 ≥7",
      desc: "攻/优需 ≥11 阶；暴伤/暴击/弹容 任一 ≥7 阶，出现在任意槽位都算",
      icon: "◆",
      apply: function () {
        applyPresetReqs([
          { cands: ["atk"], minTier: 11 },
          { cands: ["elite"], minTier: 11 },
          { cands: ["cdmg", "crit", "ammo"], minTier: 7 },
        ]);
      },
    },
  ];

  function renderPresets() {
    const area = $("#presetArea");
    area.innerHTML = PRESETS.map(function (p, i) {
      return '<button type="button" class="preset chip-preset" data-preset="' + i + '" title="' + esc(p.desc) + '">' +
        '<span class="ico">' + p.icon + "</span>" +
        '<span class="nm">' + esc(p.short || p.name) + "</span>" +
        "</button>";
    }).join("");
    $$("[data-preset]", area).forEach(function (el) {
      el.addEventListener("click", function () {
        PRESETS[+el.getAttribute("data-preset")].apply();
        scheduleMemorySave();
        renderAll();
        recalc(true);
      });
    });
  }

  /* ------------------------------------------------------------------
   * 事件绑定
   * ------------------------------------------------------------------ */
  function setupAdvToggle() {
    const head = $("#advHead");
    const body = $("#advBody");
    if (!head || !body) return;
    function setOpen(open) {
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) body.removeAttribute("hidden");
      else body.setAttribute("hidden", "");
      const sub = head.querySelector(".sub");
      if (sub) sub.textContent = open ? "可编辑 · 点击标题收起" : "可编辑 · 默认收起";
    }
    head.addEventListener("click", function () {
      setOpen(head.getAttribute("aria-expanded") !== "true");
    });
    head.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault();
        setOpen(head.getAttribute("aria-expanded") !== "true");
      }
    });
    setOpen(false);
  }

  function openSyncSidebarSync() {
    // 优先用 Edge / Chromium 的侧边栏；必须在点击手势内同步调用，禁止先 await
    if (openSidePanel(ext)) return;
    if (typeof ext?.tabs?.create === "function" && ext?.runtime?.getURL) {
      void callApi(ext.tabs, "create", {
        url: ext.runtime.getURL("sidebar.html?mode=sidebar"),
        active: true,
      }).catch(() => undefined);
    }
  }

  function bindImportEvents() {
    $("#btnOpenSidebar")?.addEventListener("click", openSyncSidebarSync);
    $("#btnEmptyOpenSidebar")?.addEventListener("click", openSyncSidebarSync);

    $("#btnEmptyOpenLogin")?.addEventListener("click", () => {
      void openBlablalinkLoginTab(ext);
    });

    $("#btnEmptyManual")?.addEventListener("click", () => {
      extState.manualMode = true;
      extState.collapsed = true;
      saveUiPrefs();
      renderImportPanel();
    });

    $("#btnToggleImport")?.addEventListener("click", () => {
      extState.collapsed = !extState.collapsed;
      saveUiPrefs();
      renderImportHeaderAndCardsOnly();
    });

    const toggleManualMode = () => {
      extState.manualMode = !extState.manualMode;
      if (!extState.manualMode && getSelectedCharacter()) {
        applySelectedPartToCalculator({ restoreMemory: true });
        recalc(true);
      }
      saveUiPrefs();
      renderImportPanel();
    };
    $("#btnManualMode")?.addEventListener("click", toggleManualMode);
    $("#btnResumeImport")?.addEventListener("click", () => {
      if (!extState.manualMode) return;
      toggleManualMode();
    });

    $("#btnResetPart")?.addEventListener("click", () => {
      const char = getSelectedCharacter();
      if (!char) return;
      const key = memoryKey(char.nameCode, extState.activePartIndex);
      delete extState.partMemory[key];
      void storageSet({ [STORAGE_KEYS.PART_MEMORY]: extState.partMemory }, ext);
      applySelectedPartToCalculator({ restoreMemory: false });
      renderImportPanel();
      recalc(true);
    });

    $("#charSearch")?.addEventListener("input", (ev) => {
      extState.searchQuery = String(ev.target?.value || "");
      renderImportPanel();
    });

    $("#onlyAffixChars")?.addEventListener("change", (ev) => {
      extState.onlyWithAffix = Boolean(ev.target?.checked);
      saveUiPrefs();
      renderImportPanel();
    });

    $("#charSelect")?.addEventListener("change", (ev) => {
      const code = String(ev.target?.value || "");
      if (!code) return;
      selectCharacter(code, { partIndex: 0, recalculate: true });
    });

    ext?.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.SNAPSHOT]) {
        extState.snapshot = changes[STORAGE_KEYS.SNAPSHOT].newValue || null;
        const chars = getAllCharacters();
        if (chars.length > 0) {
          if (extState.onlyWithAffix && !chars.some((c) => c.affixCount > 0)) {
            extState.onlyWithAffix = false;
          }
          const keepCurrent = chars.some(
            (c) => String(c.nameCode) === String(extState.selectedNameCode)
          );
          if (!keepCurrent) {
            const firstPool = extState.onlyWithAffix
              ? chars.filter((c) => c.affixCount > 0)
              : chars;
            extState.selectedNameCode = String((firstPool[0] || chars[0]).nameCode);
            extState.activePartIndex = 0;
          }
          if (!extState.manualMode) {
            applySelectedPartToCalculator({ restoreMemory: true });
            recalc(true);
          }
        }
        renderImportPanel();
      }
      if (changes[STORAGE_KEYS.PART_MEMORY]) {
        extState.partMemory = changes[STORAGE_KEYS.PART_MEMORY].newValue || {};
        renderImportHeaderAndCardsOnly();
      }
    });
  }

  function bind() {
    setupAdvToggle();
    bindImportEvents();

    $("#addReq").addEventListener("click", function () {
      if (state.cfg.reqs.length >= 3) return;
      state.cfg.reqs.push({ cands: ["atk"], minTier: 1 });
      scheduleMemorySave();
      recalc();
    });

    $("#manualOn").addEventListener("change", function () {
      state.manual.enabled = this.checked;
      $("#manualArea").style.display = this.checked ? "" : "none";
      recalc();
    });

    $("#manMaxLock").addEventListener("change", function () {
      state.manual.maxLocks = +this.value;
      recalc();
    });

    $("#manMinBand").addEventListener("change", function () {
      state.manual.minBand = +this.value;
      recalc();
    });

    $("#resetParams").addEventListener("click", function () {
      const d = E.defaultConfig();
      state.cfg.slotProbs = d.slotProbs.slice();
      state.cfg.tierProbs = d.tierProbs.slice();
      state.cfg.costs = d.costs;
      state.cfg.types.forEach(function (t, i) {
        t.weight = d.types[i].weight;
        t.values = d.types[i].values.slice();
      });
      renderAll();
      renderImportPanel();
      recalc(true);
    });

    $("#exportCfg").addEventListener("click", async function () {
      const json = JSON.stringify({ cfg: state.cfg, start: state.start, manual: state.manual }, null, 2);
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(json);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        const ta = document.createElement("textarea");
        ta.value = json;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
      }
      const btn = this;
      const old = btn.textContent;
      btn.textContent = "已复制 ✓";
      setTimeout(function () { btn.textContent = old; }, 1400);
    });

    $$("#tabs .tab").forEach(function (t) {
      t.addEventListener("click", function () {
        switchTab(t.getAttribute("data-pane"));
      });
    });
  }

  /* ------------------------------------------------------------------
   * 启动
   * ------------------------------------------------------------------ */
  function renderAll() {
    renderSlots();
    renderReqs();
    renderParams();
    renderManual();
    renderPresets();
  }

  async function hydrateFromStorage() {
    const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
    const hashCode = hashParams.get("nameCode");
    const hashPart = hashParams.get("part");

    const data = await storageGet(
      [STORAGE_KEYS.SNAPSHOT, STORAGE_KEYS.PART_MEMORY, STORAGE_KEYS.UI_PREFS],
      ext
    ).catch(() => ({}));

    extState.snapshot = data?.[STORAGE_KEYS.SNAPSHOT] || null;
    extState.partMemory = (data?.[STORAGE_KEYS.PART_MEMORY] && typeof data[STORAGE_KEYS.PART_MEMORY] === "object")
      ? data[STORAGE_KEYS.PART_MEMORY]
      : {};

    const prefs = data?.[STORAGE_KEYS.UI_PREFS] || {};
    if (typeof prefs.onlyWithAffix === "boolean") extState.onlyWithAffix = prefs.onlyWithAffix;
    if (typeof prefs.manualMode === "boolean") extState.manualMode = prefs.manualMode;
    if (typeof prefs.collapsed === "boolean") extState.collapsed = prefs.collapsed;

    const chars = getAllCharacters();
    if (chars.length > 0) {
      if (extState.onlyWithAffix && !chars.some((c) => c.affixCount > 0)) {
        extState.onlyWithAffix = false;
      }
      const preferredCode = hashCode || prefs.selectedNameCode || "";
      const hasPreferred = preferredCode && chars.some((c) => String(c.nameCode) === String(preferredCode));
      if (hasPreferred) {
        extState.selectedNameCode = String(preferredCode);
      } else {
        const pool = extState.onlyWithAffix ? chars.filter((c) => c.affixCount > 0) : chars;
        extState.selectedNameCode = String((pool[0] || chars[0]).nameCode);
      }
      const rawPart = hashPart !== null ? Number(hashPart) : Number(prefs.activePartIndex ?? 0);
      extState.activePartIndex = Number.isInteger(rawPart) ? Math.max(0, Math.min(3, rawPart)) : 0;

      if (!extState.manualMode) {
        applySelectedPartToCalculator({ restoreMemory: true });
      }
    }

    renderImportPanel();
    renderAll();
    doCalc();
  }

  function init() {
    bind();
    renderImportPanel();
    renderAll();
    doCalc();
    void hydrateFromStorage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
