/* =====================================================================
 * 主题控制：Auto / Dark / Light
 * ---------------------------------------------------------------------
 * - 首次打开且 localStorage 无记录 → 读 matchMedia 系统偏好
 * - Auto 模式下监听系统变化，实时无感同步
 * - 手动选择后写入 localStorage，下次优先读取
 * - 在 <head> 里同步执行，避免首屏闪白/闪黑（FOUC）
 * ===================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'nikke-calc-theme';
  var MEDIA = '(prefers-color-scheme: dark)';
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia(MEDIA) : null;

  function systemTheme() {
    return (mql && mql.matches) ? 'dark' : 'light';
  }

  function readPref() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'auto' || v === 'dark' || v === 'light') return v;
    } catch (e) { /* 隐私模式 / file:// 限制：静默降级 */ }
    return 'auto';
  }

  function writePref(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* 写入失败不影响使用 */ }
  }

  var pref = readPref();

  /** 解析当前应生效的实际主题 */
  function effective() {
    return pref === 'auto' ? systemTheme() : pref;
  }

  /** 把解析结果写到 <html data-theme> 与 meta[theme-color] */
  function apply() {
    var t = effective();
    if (root.getAttribute('data-theme') !== t) root.setAttribute('data-theme', t);
    var meta = document.getElementById('metaThemeColor');
    if (meta) meta.setAttribute('content', t === 'light' ? '#F3F3F3' : '#1B1B1B');
    syncButtons();
    return t;
  }

  function syncButtons() {
    var btns = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var on = b.getAttribute('data-theme-set') === pref;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) b.classList.add('on'); else b.classList.remove('on');
    }
    var lab = document.getElementById('themeNow');
    if (lab) {
      var t = effective();
      lab.textContent = pref === 'auto'
        ? '自动 · 当前' + (t === 'dark' ? '暗色' : '日间')
        : (t === 'dark' ? '暗色' : '日间');
    }
  }

  function setPref(v) {
    pref = (v === 'dark' || v === 'light' || v === 'auto') ? v : 'auto';
    writePref(pref);
    apply();
  }

  /* ---- 系统主题实时监听 ---- */
  if (mql) {
    var onChange = function () { if (pref === 'auto') apply(); };
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);  // 旧版 Safari
  }

  /* ---- 首次执行（在 head 中，DOM 尚未解析完也可用） ---- */
  apply();

  /* ---- 对外 API ---- */
  window.ThemeCtl = {
    get pref() { return pref; },
    get resolved() { return effective(); },
    set: setPref,
    toggle: function () { setPref(effective() === 'dark' ? 'light' : 'dark'); },
    /** 若用户从未手动选择，则回到跟随系统 */
    reset: function () { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} pref = 'auto'; apply(); },
    apply: apply
  };

  /* ---- DOM 就绪后绑定按钮 ---- */
  function bind() {
    var btns = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        setPref(this.getAttribute('data-theme-set'));
      });
    }
    syncButtons();
  }

  /* ---- 跨标签页/侧边栏主题实时同步 ---- */
  window.addEventListener('storage', function (ev) {
    if (ev.key === STORAGE_KEY) { pref = readPref(); apply(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
