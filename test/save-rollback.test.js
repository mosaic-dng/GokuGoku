'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gokugoku-rollback-'));
let userDataPath = userDataDir;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'electron';
  return originalResolve.call(this, request, ...args);
};
require.cache.electron = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: {
    app: {
      getPath: () => userDataPath,
      requestSingleInstanceLock: () => false,
      quit() {},
    },
  },
};

const profile = {
  weightKg: 60,
  cupMl: 200,
  intervalMin: 45,
  workStart: '09:00',
  workEnd: '18:00',
  dndRanges: [{ start: '12:00', end: '13:00' }],
};

function session() {
  userDataPath = userDataDir;
  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];
  const main = require('../main.js');
  assert.equal(main.saveProfile(profile).ok, true);
  assert.equal(main.doDrink('main').ok, true);
  const before = main.snapshot();
  userDataPath = path.join(userDataDir, 'missing', 'data');
  return { main, before };
}

test('a failed drink save restores intake and clears the undo token', () => {
  const { main, before } = session();
  const failed = main.doDrink('main');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /数据保存失败/);
  assert.equal(failed.drinkCount, before.drinkCount);
  assert.equal(failed.consumedMl, before.consumedMl);
  assert.equal(failed.undoAvailable, false);
});

test('a failed save restores undo, reset, profile, and settings', () => {
  const cases = [
    (main) => main.undoLatest(main.snapshot().undoId, 'main'),
    (main) => main.resetTodayProgress(),
    (main) => main.saveProfile({ ...profile, weightKg: 80 }),
    (main) => main.setSetting('intervalMin', 15),
  ];
  for (const mutate of cases) {
    const { main, before } = session();
    const failed = mutate(main);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /数据保存失败/);
    const state = main.snapshot();
    assert.equal(state.drinkCount, before.drinkCount);
    assert.equal(state.consumedMl, before.consumedMl);
    assert.equal(state.weightKg, before.weightKg);
    assert.equal(state.intervalMin, before.intervalMin);
    assert.equal(state.nextAt, before.nextAt);
    assert.equal(state.undoAvailable, before.undoAvailable);
  }
});

test.after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
