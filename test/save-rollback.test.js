'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gokugoku-rollback-'));
let userDataPath = userDataDir;

const electronMock = {
  app: {
    commandLine: { appendSwitch() {} },
    setPath() {},
    getPath(name) {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`);
      return userDataPath;
    },
    requestSingleInstanceLock: () => false,
    quit() {},
    on() {},
    whenReady() { return { then() {} }; },
    setAppUserModelId() {},
    setLoginItemSettings() {},
    exit() {},
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate() { return {}; } },
  ipcMain: { handle() {} },
  nativeImage: { createFromPath() { return {}; } },
  screen: {},
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, ...args) {
  if (request === 'electron') return 'electron';
  return originalResolve.call(this, request, ...args);
};
require.cache.electron = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: electronMock,
};

const profile = {
  weightKg: 60,
  cupMl: 200,
  intervalMin: 45,
  workStart: '09:00',
  workEnd: '18:00',
  dndRanges: [{ start: '12:00', end: '13:00' }],
};

function loadMain() {
  userDataPath = userDataDir;
  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];
  return require('../main.js');
}

function failWrites() {
  userDataPath = path.join(userDataDir, 'missing', 'data');
}

function readDisk() {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'gokugoku-data.json'), 'utf8'));
}

function boot() {
  const main = loadMain();
  const saved = main.saveProfile(profile);
  assert.equal(saved.ok, true);
  return main;
}

test('a failed drink save restores intake and clears the undo token', () => {
  const main = boot();
  const drunk = main.doDrink('main');
  assert.equal(drunk.ok, true);
  const before = main.snapshot();
  assert.equal(readDisk().drinkCount, before.drinkCount);

  failWrites();
  const failedDrink = main.doDrink('main');
  assert.equal(failedDrink.ok, false);
  assert.match(failedDrink.error, /数据保存失败/);
  assert.equal(failedDrink.drinkCount, before.drinkCount);
  assert.equal(failedDrink.consumedMl, before.consumedMl);
  assert.equal(failedDrink.undoAvailable, false);
  assert.equal(failedDrink.nextAt, before.nextAt);
  assert.equal(main.snapshot().undoAvailable, false);
  assert.equal(readDisk().drinkCount, before.drinkCount);
  assert.equal(readDisk().consumedMl, before.consumedMl);
});

test('save failure restores an undo and leaves a rejected undo unsaved', () => {
  const main = boot();
  const drunk = main.doDrink('main');
  const before = main.snapshot();
  failWrites();
  const failedUndo = main.undoLatest(drunk.undoId, 'main');
  assert.equal(failedUndo.ok, false);
  assert.equal(failedUndo.reason, 'storage');
  assert.match(failedUndo.error, /数据保存失败/);
  assert.equal(failedUndo.state.drinkCount, before.drinkCount);
  assert.equal(failedUndo.state.consumedMl, before.consumedMl);
  assert.equal(failedUndo.state.undoId, drunk.undoId);
  assert.equal(main.snapshot().undoId, drunk.undoId);
  assert.equal(readDisk().drinkCount, before.drinkCount);

  const fresh = boot();
  fresh.doDrink('main');
  const diskBefore = readDisk();
  failWrites();
  const rejected = fresh.undoLatest('missing', 'main');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'not-latest');
  assert.equal(fresh.snapshot().storageError, null);
  assert.equal(fresh.snapshot().drinkCount, 1);
  assert.deepEqual(readDisk(), diskBefore);
});

test('save failure restores today reset, profile edits, and settings', () => {
  let main = boot();
  main.doDrink('main');
  const beforeReset = main.snapshot();
  const diskBeforeReset = readDisk();
  failWrites();
  const failedReset = main.resetTodayProgress();
  assert.equal(failedReset.ok, false);
  assert.match(failedReset.error, /数据保存失败/);
  assert.equal(failedReset.state.drinkCount, beforeReset.drinkCount);
  assert.equal(failedReset.state.consumedMl, beforeReset.consumedMl);
  assert.equal(failedReset.state.nextAt, beforeReset.nextAt);
  assert.equal(failedReset.state.undoAvailable, beforeReset.undoAvailable);
  assert.deepEqual(readDisk(), diskBeforeReset);

  main = boot();
  main.doDrink('main');
  const beforeProfile = main.snapshot();
  failWrites();
  const failedProfile = main.saveProfile({
    ...profile,
    weightKg: 80,
    cupMl: 250,
    dndRanges: [{ start: '14:00', end: '15:00' }],
  });
  assert.equal(failedProfile.ok, false);
  assert.match(failedProfile.error, /数据保存失败/);
  const afterProfile = main.snapshot();
  assert.equal(afterProfile.weightKg, beforeProfile.weightKg);
  assert.equal(afterProfile.cupMl, beforeProfile.cupMl);
  assert.deepEqual(afterProfile.dndRanges, beforeProfile.dndRanges);
  assert.equal(afterProfile.profileRequired, false);
  assert.equal(afterProfile.nextAt, beforeProfile.nextAt);
  assert.equal(afterProfile.drinkCount, beforeProfile.drinkCount);
  assert.equal(readDisk().settings.weightKg, 60);
  assert.deepEqual(readDisk().settings.dndRanges, profile.dndRanges);

  main = boot();
  main.doDrink('main');
  const beforeSetting = main.snapshot();
  failWrites();
  const failedInterval = main.setSetting('intervalMin', 15);
  assert.equal(failedInterval.ok, false);
  assert.match(failedInterval.error, /数据保存失败/);
  assert.equal(failedInterval.intervalMin, beforeSetting.intervalMin);
  assert.equal(failedInterval.nextAt, beforeSetting.nextAt);
  assert.equal(readDisk().settings.intervalMin, 45);

  main = boot();
  main.doDrink('main');
  const beforeHours = main.snapshot();
  failWrites();
  const failedHours = main.setSetting('workStart', '10:30');
  assert.equal(failedHours.ok, false);
  assert.equal(failedHours.workStart, '09:00');
  assert.equal(failedHours.workEnd, '18:00');
  assert.equal(failedHours.nextAt, beforeHours.nextAt);
  assert.equal(readDisk().settings.workStart, '09:00');

  main = boot();
  main.doDrink('main');
  const beforeWeekend = main.snapshot();
  failWrites();
  const failedWeekend = main.setSetting('weekend', true);
  assert.equal(failedWeekend.ok, false);
  assert.equal(failedWeekend.weekend, false);
  assert.equal(failedWeekend.nextAt, beforeWeekend.nextAt);

  main = boot();
  main.doDrink('main');
  const beforeSound = main.snapshot();
  failWrites();
  const failedSound = main.setSetting('sound', false);
  assert.equal(failedSound.ok, false);
  assert.equal(failedSound.sound, true);
  assert.equal(failedSound.nextAt, beforeSound.nextAt);
  assert.equal(readDisk().settings.sound, true);
});

test.after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
