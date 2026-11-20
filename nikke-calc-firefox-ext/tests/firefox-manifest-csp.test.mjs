// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_FILES, packageExtension } from "../scripts/package-ext.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");

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

test("manifest.json conforms to Firefox MV3 requirements", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8")
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings?.gecko?.id, "nikke-equip-calc@nikkelines.local");
  assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, "140.0");
  assert.deepEqual(
    manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
    ["none"]
  );

  assert.equal(manifest.sidebar_action?.default_panel, "sidebar.html?mode=sidebar");
  assert.equal(manifest.action?.default_popup, "sidebar.html?mode=popup");
  assert.deepEqual(manifest.background?.scripts, ["background.js"]);
  assert.equal(manifest.background?.type, "module");

  assert.equal(manifest.background?.service_worker, undefined);
  assert.equal(manifest.side_panel, undefined);
  assert.ok(!manifest.permissions.includes("sidePanel"));

  assert.deepEqual(manifest.host_permissions, ["*://*.blablalink.com/*"]);
  assert.match(manifest.content_security_policy?.extension_pages || "", /script-src 'self'/);
  assert.ok(!/unsafe-inline/i.test(manifest.content_security_policy?.extension_pages || ""));

  for (const [sizeStr, relPath] of Object.entries(manifest.icons || {})) {
    const absPath = path.join(EXT_ROOT, relPath);
    assert.ok(fs.existsSync(absPath), `Missing icon: ${relPath}`);
    const dim = readPngDimensions(fs.readFileSync(absPath));
    const expectedSize = Number(sizeStr);
    assert.equal(dim.width, expectedSize);
    assert.equal(dim.height, expectedSize);
  }
});

test("HTML pages strictly satisfy Firefox MV3 CSP (zero inline scripts or on* handlers)", () => {
  for (const htmlName of ["calculator.html", "sidebar.html"]) {
    const htmlPath = path.join(EXT_ROOT, htmlName);
    const html = fs.readFileSync(htmlPath, "utf8");

    // 1. Every <script> tag must have a src attribute and empty inner body
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

    // 2. Every stylesheet link must resolve to an existing file
    const linkTags = [...html.matchAll(/<link\b([^>]*rel\s*=\s*["']stylesheet["'][^>]*)>/gi)];
    assert.ok(linkTags.length >= 1, `${htmlName} should include stylesheet`);
    for (const match of linkTags) {
      const hrefMatch = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
      assert.ok(hrefMatch, `${htmlName} stylesheet link missing href`);
      const cssFile = path.join(EXT_ROOT, hrefMatch[1].split("?")[0]);
      assert.ok(fs.existsSync(cssFile), `${htmlName} references missing CSS: ${hrefMatch[1]}`);
    }

    // 3. Zero inline event handlers (onclick=, onchange=, etc.)
    const inlineHandlerMatches = html.match(/\son[a-z]+\s*=/gi);
    assert.equal(inlineHandlerMatches, null, `${htmlName} contains inline event handlers`);
  }
});

test("packaged .zip and .xpi contain exact POSIX-path runtime files and exclude dev artifacts", () => {
  const out = packageExtension(EXT_ROOT);
  const zipBuf = fs.readFileSync(out.zipPath);
  const xpiBuf = fs.readFileSync(out.xpiPath);

  assert.equal(Buffer.compare(zipBuf, xpiBuf), 0, ".zip and .xpi should be identical archives");

  const entries = readZipEntriesFromBuffer(xpiBuf);
  assert.deepEqual(entries, [...RUNTIME_FILES]);

  for (const name of entries) {
    assert.ok(!name.includes("\\"), `Entry uses backslash: ${name}`);
    assert.ok(!name.startsWith("tests/"), `Test file leaked into package: ${name}`);
    assert.ok(!name.startsWith("scripts/"), `Script leaked into package: ${name}`);
    assert.ok(!name.startsWith("dist/"), `Dist leaked into package: ${name}`);
  }
});
