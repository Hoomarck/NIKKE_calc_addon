// SPDX-License-Identifier: GPL-3.0-or-later
// Edge / Chromium MV3 清单与打包约束校验
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_FILES, packageExtension } from "../scripts/package-ext.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");

/** Chromium（Edge / Chrome）当前认可的 MV3 权限字符串 */
const VALID_CHROMIUM_PERMISSIONS = new Set([
  "cookies",
  "storage",
  "tabs",
  "sidePanel",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
  "declarativeNetRequestFeedback",
  "activeTab",
  "scripting",
  "notifications",
  "windows",
  "alarms",
  "clipboardWrite",
]);

function readPngDimensions(buf) {
  const pngSig = "89504e470d0a1a0a";
  assert.equal(buf.subarray(0, 8).toString("hex"), pngSig);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function readZipEntriesFromBuffer(buf) {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, "EOCD signature not found in archive");

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const names = [];
  let cursor = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    assert.equal(buf.readUInt32LE(cursor), 0x02014b50, "Invalid central directory header");
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    names.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return names;
}

const readManifest = () =>
  JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8"));

test("manifest.json conforms to Edge / Chromium MV3 requirements", () => {
  const manifest = readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, "string");
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
  assert.ok(manifest.description.length <= 132, "description must fit store limit");

  // 页面入口：工具栏弹窗 + 侧边栏
  assert.equal(manifest.action?.default_popup, "sidebar.html?mode=popup");
  assert.equal(manifest.side_panel?.default_path, "sidebar.html");
  assert.ok(manifest.permissions.includes("sidePanel"));

  // MV3 Service Worker 后台（Chromium 不支持 background.scripts / background.page）
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.equal(manifest.background?.type, "module");
  assert.equal(manifest.background?.scripts, undefined);
  assert.equal(manifest.background?.page, undefined);

  // 权限声明
  for (const permission of manifest.permissions) {
    assert.ok(
      VALID_CHROMIUM_PERMISSIONS.has(permission),
      `Unknown Chromium permission: ${permission}`
    );
  }
  assert.deepEqual(manifest.host_permissions, ["*://*.blablalink.com/*"]);

  // CSP 只能收紧默认策略，且不得放开内联脚本
  const csp = manifest.content_security_policy?.extension_pages || "";
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/i.test(csp), "CSP must not allow unsafe-inline/unsafe-eval");

  // 图标：清单声明与真实 PNG 尺寸一致
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "32", "48"]);
  for (const [sizeStr, relPath] of Object.entries(manifest.icons)) {
    const absPath = path.join(EXT_ROOT, relPath);
    assert.ok(fs.existsSync(absPath), `Missing icon: ${relPath}`);
    const dim = readPngDimensions(fs.readFileSync(absPath));
    assert.equal(dim.width, Number(sizeStr));
    assert.equal(dim.height, Number(sizeStr));
  }
  assert.deepEqual(manifest.action?.default_icon, manifest.icons);
});

test("no Firefox-only manifest keys or browser.* namespace usage remains", () => {
  const manifest = readManifest();

  for (const legacyKey of ["browser_specific_settings", "applications", "sidebar_action", "browser_action"]) {
    assert.equal(manifest[legacyKey], undefined, `Firefox-only manifest key leaked: ${legacyKey}`);
  }
  assert.equal(manifest.manifest_version, 3);

  const jsFiles = fs
    .readdirSync(EXT_ROOT)
    .filter((name) => name.endsWith(".js") && name !== "extension-api.js");

  for (const fileName of jsFiles) {
    const rawSource = fs.readFileSync(path.join(EXT_ROOT, fileName), "utf8");
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.equal(
      /\bbrowser\s*\./.test(source),
      false,
      `${fileName} still calls browser.* directly (use ./extension-api.js instead)`
    );
    assert.equal(
      /globalThis\.browser/.test(source),
      false,
      `${fileName} resolves the browser namespace itself (use ./extension-api.js instead)`
    );
  }

  // 兼容垫片必须存在且被列为运行时文件
  assert.ok(fs.existsSync(path.join(EXT_ROOT, "extension-api.js")));
  assert.ok(RUNTIME_FILES.includes("extension-api.js"));
});

test("every relative ES module import resolves to a packaged file", () => {
  const jsFiles = fs.readdirSync(EXT_ROOT).filter((name) => name.endsWith(".js"));
  for (const fileName of jsFiles) {
    const source = fs.readFileSync(path.join(EXT_ROOT, fileName), "utf8");
    const specs = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(EXT_ROOT, spec);
      assert.ok(fs.existsSync(target), `${fileName} imports missing module: ${spec}`);
      assert.ok(
        RUNTIME_FILES.includes(spec.replace(/^\.\//, "")),
        `${fileName} imports module not shipped in the package: ${spec}`
      );
    }
  }
});

test("HTML pages strictly satisfy Chromium MV3 CSP (zero inline scripts or on* handlers)", () => {
  for (const htmlName of ["calculator.html", "sidebar.html"]) {
    const htmlPath = path.join(EXT_ROOT, htmlName);
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. 每个 <script> 都要有 src，且标签体为空
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptTags.length >= 2, `${htmlName} should load external scripts`);
    for (const match of scriptTags) {
      const attrs = match[1];
      const body = match[2].trim();
      const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      assert.ok(srcMatch, `${htmlName} contains inline <script> without src`);
      assert.equal(body, "", `${htmlName} script tag with src must not have inline body`);
      const scriptFile = path.join(EXT_ROOT, srcMatch[1].split("?")[0]);
      assert.ok(fs.existsSync(scriptFile), `${htmlName} references missing script: ${srcMatch[1]}`);
    }

    // 2. 样式表链接必须指向存在的文件
    const linkTags = [...html.matchAll(/<link\b([^>]*rel\s*=\s*["']stylesheet["'][^>]*)>/gi)];
    assert.ok(linkTags.length >= 1, `${htmlName} should include stylesheet`);
    for (const match of linkTags) {
      const hrefMatch = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
      assert.ok(hrefMatch, `${htmlName} stylesheet link missing href`);
      const cssFile = path.join(EXT_ROOT, hrefMatch[1].split("?")[0]);
      assert.ok(fs.existsSync(cssFile), `${htmlName} references missing CSS: ${hrefMatch[1]}`);
    }

    // 3. 零内联事件处理器
    const inlineHandlerMatches = html.match(/\son[a-z]+\s*=/gi);
    assert.equal(inlineHandlerMatches, null, `${htmlName} contains inline event handlers`);
  }
});

test("packaged zip contains exact POSIX-path runtime files and excludes dev artifacts", () => {
  const out = packageExtension(EXT_ROOT);
  const zipBuf = fs.readFileSync(out.zipPath);
  const entries = readZipEntriesFromBuffer(zipBuf);

  assert.deepEqual(entries, [...RUNTIME_FILES]);

  for (const name of entries) {
    assert.ok(!name.includes("\\"), `Entry uses backslash: ${name}`);
    assert.ok(!name.startsWith("tests/"), `Test file leaked into package: ${name}`);
    assert.ok(!name.startsWith("scripts/"), `Script leaked into package: ${name}`);
    assert.ok(!name.startsWith("dist/"), `Dist leaked into package: ${name}`);
  }
});
