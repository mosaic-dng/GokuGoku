'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);
const APP_IGNORE_PATTERNS = [
  /^\/dist(?:\/|$)/,
  /^\/node_modules(?:\/|$)/,
  /^\/test(?:\/|$)/,
  /^\/docs(?:\/|$)/,
  /^\/scripts(?:\/|$)/,
  /^\/\.github(?:\/|$)/,
  /^\/\.gitignore$/,
  /^\/\.tmp-/,
  /^\/\.electron-dev(?:\/|$)/,
  /^\/\.pack-stage(?:\/|$)/,
  /^\/\.shot-data(?:\/|$)/,
  /^\/\.shots(?:\/|$)/,
  /^\/\.release-work(?:\/|$)/,
  /^\/README\.md$/,
  /^\/使用说明\.md$/,
  /^\/package-lock\.json$/,
  /^\/app\.asar$/,
  /(?:^|\/)gen-assets\.js$/,
];

function pruneLocales(portableRoot) {
  const localesDir = path.join(portableRoot, 'locales');
  if (!fs.existsSync(localesDir)) throw new Error(`语言包目录不存在：${localesDir}`);

  const removed = [];
  for (const entry of fs.readdirSync(localesDir)) {
    if (!entry.endsWith('.pak') || KEEP_LOCALES.has(entry)) continue;
    fs.rmSync(path.join(localesDir, entry));
    removed.push(entry);
  }
  return removed;
}

function createPackagerOptions(env = process.env) {
  return {
    dir: PROJECT_ROOT,
    name: 'GokuGoku',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(PROJECT_ROOT, 'assets', 'app.ico'),
    out: path.join(PROJECT_ROOT, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    ignore: APP_IGNORE_PATTERNS,
    win32metadata: {
      CompanyName: '水分補給課',
      ProductName: '水分補給課',
    },
    ...(env.ELECTRON_ZIP_DIR
      ? { electronZipDir: path.resolve(env.ELECTRON_ZIP_DIR) }
      : {}),
  };
}

async function buildWindowsPortable() {
  const { packager } = await import('@electron/packager');
  const outputPaths = await packager(createPackagerOptions());

  for (const outputPath of outputPaths) {
    const removed = pruneLocales(outputPath);
    process.stdout.write(`便携目录：${outputPath}\n`);
    process.stdout.write(`已移除 ${removed.length} 个非中英文语言包。\n`);
  }
  return outputPaths;
}

if (require.main === module) {
  buildWindowsPortable().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APP_IGNORE_PATTERNS,
  KEEP_LOCALES,
  buildWindowsPortable,
  createPackagerOptions,
  pruneLocales,
};
