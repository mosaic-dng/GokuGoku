'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../package.json');
const {
  APP_IGNORE_PATTERNS,
  KEEP_LOCALES,
  createPackagerOptions,
  pruneLocales,
} = require('../scripts/pack-win.js');
const { EXPECTED_SHOTS, verifyShots } = require('../scripts/verify-shots.js');

test('Windows packaging keeps only Chinese and English locale packs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gokugoku-locales-'));
  const locales = path.join(root, 'locales');
  fs.mkdirSync(locales);
  for (const name of ['zh-CN.pak', 'en-US.pak', 'ja.pak', 'fr.pak', 'notes.txt']) {
    fs.writeFileSync(path.join(locales, name), name);
  }

  try {
    const removed = pruneLocales(root);
    assert.deepEqual(KEEP_LOCALES, new Set(['zh-CN.pak', 'en-US.pak']));
    assert.deepEqual(fs.readdirSync(locales).sort(), ['en-US.pak', 'notes.txt', 'zh-CN.pak']);
    assert.deepEqual(removed.sort(), ['fr.pak', 'ja.pak']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portable app excludes development material without removing runtime assets', () => {
  assert.equal(packageJson.scripts['pack:win'], 'node scripts/pack-win.js');

  const samples = [
    ['test/ui-contract.test.js', true],
    ['docs/RELEASING.md', true],
    ['.github/workflows/release.yml', true],
    ['.tmp-shot/example.png', true],
    ['README.md', true],
    ['package-lock.json', true],
    ['main.js', false],
    ['preload.js', false],
    ['ui/index.html', false],
    ['assets/app.ico', false],
    ['LICENSE', false],
  ];

  for (const [file, shouldIgnore] of samples) {
    assert.equal(
      APP_IGNORE_PATTERNS.some((pattern) => pattern.test(`/${file}`)),
      shouldIgnore,
      `${file} ignore=${shouldIgnore}`,
    );
  }
});

test('packaging cleanup is scoped to locale pak files', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pack-win.js'), 'utf8');
  assert.match(source, /entry\.endsWith\('\.pak'\)/);
  for (const protectedName of [
    'd3dcompiler_47.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'vk_swiftshader.dll',
    'v8_context_snapshot.bin',
    'icudtl.dat',
    'LICENSE',
  ]) {
    assert.equal(source.includes(`rmSync('${protectedName}'`), false);
  }
});

test('packaging can reuse an explicitly provided official Electron ZIP directory', () => {
  const options = createPackagerOptions({ ELECTRON_ZIP_DIR: 'C:\\cache\\electron' });
  assert.equal(options.electronZipDir, path.resolve('C:\\cache\\electron'));
  assert.equal(options.platform, 'win32');
  assert.equal(options.arch, 'x64');
});

test('CI and release verify the real portable app and Electron screenshots', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  for (const workflow of [ci, release]) {
    assert.match(workflow, /npm run verify:win/);
    assert.match(workflow, /SHOT_DIR/);
    assert.match(workflow, /npm run verify:shots/);
  }
  assert.equal(packageJson.scripts['verify:win'], 'node scripts/verify-win-package.js');
  assert.equal(packageJson.scripts['verify:shots'], 'node scripts/verify-shots.js');
});

test('release ZIP uses maximum compression and enforces the approximate 128 MiB target', () => {
  const release = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(release, /tar\.exe -a -c -f/);
  assert.match(release, /\$archiveSize -gt 128MB/);
  assert.doesNotMatch(release, /Compress-Archive/);
});

test('portable verifier audits size, runtime files, locales, and ASAR exclusions', () => {
  const verifier = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'verify-win-package.js'),
    'utf8',
  );
  const shotVerifier = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'verify-shots.js'),
    'utf8',
  );

  assert.match(verifier, /305 \* 1024 \* 1024/);
  assert.match(verifier, /LICENSES\.chromium\.html/);
  assert.match(verifier, /vk_swiftshader\.dll/);
  assert.match(verifier, /icudtl\.dat/);
  assert.match(verifier, /app\.asar/);
  assert.match(shotVerifier, /'shot-onboarding-880\.png': \[480, 880\]/);
  assert.match(shotVerifier, /'shot-onboarding-720-step1\.png': \[480, 720\]/);
  assert.match(shotVerifier, /'shot-reminder\.png': \[520, 380\]/);
  assert.deepEqual(EXPECTED_SHOTS['shot-reminder-snooze-menu.png'], [520, 380]);
});

test('screenshot verifier accepts settings height constrained by the runner work area', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gokugoku-shots-'));
  const dimensions = {
    'shot-onboarding-880.png': [480, 880],
    'shot-onboarding-720-step1.png': [480, 720],
    'shot-onboarding-720-step2.png': [480, 720],
    'shot-main.png': [480, 720],
    'shot-undo.png': [480, 720],
    'shot-main-open.png': [480, 696],
    'shot-settings-bottom.png': [480, 696],
    'shot-reminder.png': [520, 380],
    'shot-reminder-snooze-menu.png': [520, 380],
  };

  try {
    for (const [name, [width, height]] of Object.entries(dimensions)) {
      const header = Buffer.alloc(24);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
      header.writeUInt32BE(width, 16);
      header.writeUInt32BE(height, 20);
      fs.writeFileSync(path.join(root, name), header);
    }

    assert.doesNotThrow(() => verifyShots(root));
    const tooShort = fs.readFileSync(path.join(root, 'shot-main-open.png'));
    tooShort.writeUInt32BE(639, 20);
    fs.writeFileSync(path.join(root, 'shot-main-open.png'), tooShort);
    assert.throws(() => verifyShots(root), /尺寸错误/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
