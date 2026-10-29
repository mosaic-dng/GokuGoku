'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../lib/data.js');

const {
  createDefaultDatabase,
  migrateDatabase,
  recordDrink,
  rolloverDay,
  undoDrink,
} = require('../lib/data.js');

test('new database starts with the recommended 200ml cup and lunch DND', () => {
  const db = createDefaultDatabase('2026-07-27');

  assert.equal(db.schemaVersion, 3);
  assert.equal(db.profileCompleted, false);
  assert.equal(db.settings.cupMl, 200);
  assert.equal(db.settings.intervalMin, 45);
  assert.equal(Object.hasOwn(db.settings, 'intervalMode'), false);
  assert.equal(db.settings.workStart, '09:00');
  assert.equal(db.settings.workEnd, '18:00');
  assert.deepEqual(db.settings.dndRanges, [{ start: '12:00', end: '13:00' }]);
  assert.equal(db.consumedMl, 0);
});

test('legacy interval mode is ignored without changing its saved minutes', () => {
  const legacyMode = ['a', 'u', 't', 'o'].join('');
  const result = migrateDatabase({
    schemaVersion: 2,
    profileCompleted: true,
    settings: {
      weightKg: 60,
      cupMl: 200,
      intervalMin: 75,
      intervalMode: legacyMode,
      dndRanges: [],
    },
  }, '2026-07-27');

  assert.equal(result.db.settings.intervalMin, 75);
  assert.equal(Object.hasOwn(result.db.settings, 'intervalMode'), false);
  assert.equal(result.migratedFromVersion, 2);
  assert.equal(result.db.schemaVersion, 3);
  assert.equal(result.db.settings.workStart, '09:00');
  assert.equal(result.db.settings.workEnd, '18:00');
});

test('v1 cups and history migrate using the old 250ml cup size', () => {
  const result = migrateDatabase({
    settings: { intervalMin: 60, sound: false },
    date: '2026-07-26',
    cups: 3,
    lastDrinkAt: 1234,
    history: { '2026-07-25': 4 },
  }, '2026-07-26');

  assert.equal(result.migratedFromVersion, 1);
  assert.equal(result.db.drinkCount, 3);
  assert.equal(result.db.consumedMl, 750);
  assert.equal(result.db.settings.intervalMin, 60);
  assert.equal(result.db.settings.sound, false);
  assert.deepEqual(result.db.history['2026-07-25'], {
    drinkCount: 4,
    consumedMl: 1000,
    estimated: true,
  });
});

test('v2 work hours migrate to minute-precise clock strings', () => {
  const result = migrateDatabase({
    schemaVersion: 2,
    profileCompleted: true,
    settings: {
      weightKg: 60,
      cupMl: 200,
      intervalMin: 45,
      workStart: 9.5,
      workEnd: 18,
      dndRanges: [],
    },
  }, '2026-07-27');

  assert.equal(result.migratedFromVersion, 2);
  assert.equal(result.db.settings.workStart, '09:30');
  assert.equal(result.db.settings.workEnd, '18:00');
});

test('v3 clock strings are preserved without reporting a migration', () => {
  const result = migrateDatabase({
    schemaVersion: 3,
    profileCompleted: true,
    settings: {
      weightKg: 60,
      cupMl: 200,
      intervalMin: 45,
      workStart: '09:15',
      workEnd: '18:45',
      dndRanges: [],
    },
  }, '2026-07-27');

  assert.equal(result.migratedFromVersion, null);
  assert.equal(result.db.settings.workStart, '09:15');
  assert.equal(result.db.settings.workEnd, '18:45');
});

test('future database schemas are rejected instead of being treated as v1', () => {
  assert.throws(
    () => migrateDatabase({
      schemaVersion: 4,
      profileCompleted: true,
      drinkCount: 5,
      consumedMl: 1000,
    }, '2026-07-27'),
    /不支持的数据版本/,
  );
});

test('migration sanitizes corrupted progress and history values', () => {
  const result = migrateDatabase({
    schemaVersion: 3,
    profileCompleted: 'yes',
    settings: {
      weightKg: 60,
      cupMl: 200,
      intervalMin: 45,
      workStart: '09:00',
      workEnd: '18:00',
      dndRanges: [],
    },
    date: 'not-a-date',
    drinkCount: 'not-a-number',
    consumedMl: 'Infinity',
    lastDrinkAt: 'broken',
    history: {
      '2026-07-26': { drinkCount: '3.9', consumedMl: 'not-a-number', estimated: 'yes' },
      '2026-07-25': { drinkCount: -2, consumedMl: -50, estimated: true },
      'not-a-date': { drinkCount: 9, consumedMl: 1800 },
    },
  }, '2026-07-27');

  assert.equal(result.db.profileCompleted, false);
  assert.equal(result.db.date, '2026-07-27');
  assert.equal(result.db.drinkCount, 0);
  assert.equal(result.db.consumedMl, 0);
  assert.equal(result.db.lastDrinkAt, null);
  assert.deepEqual(result.db.history, {
    '2026-07-26': { drinkCount: 3, consumedMl: 0 },
    '2026-07-25': { drinkCount: 0, consumedMl: 0, estimated: true },
  });
});

test('recording a drink uses the current cup capacity and returns exact undo data', () => {
  const db = createDefaultDatabase('2026-07-27');
  db.settings.cupMl = 300;
  db.lastDrinkAt = 100;

  const undo = recordDrink(db, 1000, 'drink-1');

  assert.equal(db.drinkCount, 1);
  assert.equal(db.consumedMl, 300);
  assert.equal(db.lastDrinkAt, 1000);
  assert.equal(undo.amountMl, 300);
  assert.equal(undo.previousLastDrinkAt, 100);
  assert.equal(undo.expiresAt, 11000);
});

test('undo restores totals and the previous last-drink timestamp within 10 seconds', () => {
  const db = createDefaultDatabase('2026-07-27');
  db.settings.cupMl = 250;
  db.lastDrinkAt = 100;
  const undo = recordDrink(db, 1000, 'drink-1');

  const result = undoDrink(db, undo, 'drink-1', 10999);

  assert.deepEqual(result, { ok: true, reason: null });
  assert.equal(db.drinkCount, 0);
  assert.equal(db.consumedMl, 0);
  assert.equal(db.lastDrinkAt, 100);
});

test('undo rejects expired and mismatched drink identifiers', () => {
  const db = createDefaultDatabase('2026-07-27');
  const undo = recordDrink(db, 1000, 'drink-1');

  assert.equal(undoDrink(db, undo, 'drink-2', 2000).reason, 'not-latest');
  assert.equal(undoDrink(db, undo, 'drink-1', 11001).reason, 'expired');
  assert.equal(db.drinkCount, 1);
});

test('day rollover archives millilitres and resets current progress', () => {
  const db = createDefaultDatabase('2026-07-26');
  db.drinkCount = 4;
  db.consumedMl = 800;
  db.lastDrinkAt = 1234;

  rolloverDay(db, '2026-07-27');

  assert.deepEqual(db.history['2026-07-26'], { drinkCount: 4, consumedMl: 800 });
  assert.equal(db.date, '2026-07-27');
  assert.equal(db.drinkCount, 0);
  assert.equal(db.consumedMl, 0);
  assert.equal(db.lastDrinkAt, null);
});

test('reset today clears only current progress', () => {
  assert.equal(typeof data.resetToday, 'function');
  const db = data.createDefaultDatabase('2026-07-27');
  db.profileCompleted = true;
  db.settings.weightKg = 60;
  db.settings.cupMl = 300;
  db.drinkCount = 7;
  db.consumedMl = 1700;
  db.lastDrinkAt = 123456;
  db.history['2026-07-26'] = { drinkCount: 5, consumedMl: 1000 };
  const settingsBefore = structuredClone(db.settings);
  const historyBefore = structuredClone(db.history);

  data.resetToday(db);

  assert.equal(db.drinkCount, 0);
  assert.equal(db.consumedMl, 0);
  assert.equal(db.lastDrinkAt, null);
  assert.deepEqual(db.settings, settingsBefore);
  assert.deepEqual(db.history, historyBefore);
});

test('reset today archives the previous day before clearing a new day', () => {
  const db = data.createDefaultDatabase('2026-07-27');
  db.drinkCount = 7;
  db.consumedMl = 1700;
  db.lastDrinkAt = 123456;

  data.resetToday(db, '2026-07-28');

  assert.deepEqual(db.history['2026-07-27'], {
    drinkCount: 7,
    consumedMl: 1700,
  });
  assert.equal(db.date, '2026-07-28');
  assert.equal(db.drinkCount, 0);
  assert.equal(db.consumedMl, 0);
  assert.equal(db.lastDrinkAt, null);
});
