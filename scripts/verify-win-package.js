'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_PORTABLE_BYTES = 305 * 1024 * 1024;
const REQUIRED_RUNTIME_FILES = [
  'GokuGoku.exe',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'LICENSE',
  'LICENSES.chromium.html',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
];
const EXPECTED_LOCALES = ['en-US.pak', 'zh-CN.pak'];
const FORBIDDEN_ASAR_PATHS = [
  /^\/(?:test|docs|node_modules|\.github)(?:\/|$)/,
  /^\/scripts\/(?!shot-mode\.js$).+/,
  /^\/(?:README\.md|使用说明\.md|package-lock\.json)$/,
  /(?:^|\/)(?:\.shots|\.shot-data|\.tmp-|gen-assets\.js)/,
];

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}

function verifyWindowsPackage(portableRoot) {
  const asar = require('@electron/asar');
  for (const relativePath of REQUIRED_RUNTIME_FILES) {
    if (!fs.existsSync(path.join(portableRoot, relativePath))) {
      throw new Error(`缺少运行文件：${relativePath}`);
    }
  }

  const locales = fs.readdirSync(path.join(portableRoot, 'locales'))
    .filter((name) => name.endsWith('.pak'))
    .sort();
  if (JSON.stringify(locales) !== JSON.stringify(EXPECTED_LOCALES)) {
    throw new Error(`语言包不符合约定：${locales.join(', ')}`);
  }

  const asarPath = path.join(portableRoot, 'resources', 'app.asar');
  const asarEntries = asar.listPackage(asarPath)
    .map((entry) => entry.replaceAll('\\', '/'));
  const forbidden = asarEntries.filter((entry) => (
    FORBIDDEN_ASAR_PATHS.some((pattern) => pattern.test(entry))
  ));
  if (forbidden.length) throw new Error(`app.asar 含开发文件：${forbidden.join(', ')}`);

  const bytes = directorySize(portableRoot);
  if (bytes > MAX_PORTABLE_BYTES) {
    throw new Error(`便携目录超出 305 MiB：${(bytes / 1024 / 1024).toFixed(2)} MiB`);
  }

  return { bytes, locales, asarEntries: asarEntries.length };
}

if (require.main === module) {
  const portableRoot = path.resolve(
    process.argv[2] || path.join(__dirname, '..', 'dist', 'GokuGoku-win32-x64'),
  );
  const result = verifyWindowsPackage(portableRoot);
  process.stdout.write(
    `便携包验收通过：${(result.bytes / 1024 / 1024).toFixed(2)} MiB，`
    + `${result.locales.join(' / ')}，app.asar ${result.asarEntries} 项。\n`,
  );
}

module.exports = {
  EXPECTED_LOCALES,
  FORBIDDEN_ASAR_PATHS,
  MAX_PORTABLE_BYTES,
  REQUIRED_RUNTIME_FILES,
  directorySize,
  verifyWindowsPackage,
};
