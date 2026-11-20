// SPDX-License-Identifier: GPL-3.0-or-later
// 纯 Node 标准库 ZIP/XPI 打包脚本（零第三方依赖，强制 POSIX 正斜杠路径）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const RUNTIME_FILES = Object.freeze([
  "manifest.json",
  "background.js",
  "theme.js",
  "engine.js",
  "t2s.js",
  "blablalink-api.js",
  "sidebar.html",
  "sidebar.css",
  "sidebar.js",
  "calculator.html",
  "calculator.css",
  "calculator.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const entryName = entry.name.replace(/\\/g, "/");
    if (entryName.includes("\\") || entryName.startsWith("/")) {
      throw new Error(`Invalid archive entry path: ${entryName}`);
    }
    const nameBuf = Buffer.from(entryName, "utf8");
    const rawBuf = entry.data;
    const deflated = zlib.deflateRawSync(rawBuf, { level: 9 });
    const useDeflate = deflated.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawBuf;
    const crc = crc32(rawBuf);
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime || new Date());

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x0314, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset >>> 0, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

export function packageExtension(rootDir) {
  const distDir = path.join(rootDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const entries = RUNTIME_FILES.map((relPath) => {
    const absPath = path.join(rootDir, ...relPath.split("/"));
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing required runtime file: ${relPath}`);
    }
    const stat = fs.statSync(absPath);
    return {
      name: relPath,
      data: fs.readFileSync(absPath),
      mtime: stat.mtime,
    };
  });

  const zipBuf = buildZipBuffer(entries);
  const zipPath = path.join(distDir, "nikke-calc-firefox-ext.zip");
  const xpiPath = path.join(distDir, "nikke-calc-firefox-ext.xpi");
  fs.writeFileSync(zipPath, zipBuf);
  fs.writeFileSync(xpiPath, zipBuf);

  return {
    zipPath,
    xpiPath,
    bytes: zipBuf.length,
    files: entries.map((e) => e.name),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const out = packageExtension(rootDir);
  console.log(`Packaged ${out.files.length} files (${out.bytes} bytes) ->`);
  console.log(`  ZIP: ${out.zipPath}`);
  console.log(`  XPI: ${out.xpiPath}`);
}
