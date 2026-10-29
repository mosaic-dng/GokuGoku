'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateTargets,
  getReminderAvailability,
  validateWorkHours,
  validateIntervalMin,
  validateProfileInput,
  validateProfileNumbers,
  validateDndRanges,
} = require('../lib/hydration.js');

test('default setup and settings preview targets stay on the shared formula', () => {
  assert.deepEqual(calculateTargets({
    weightKg: 60,
    cupMl: 200,
    workStart: '09:00',
    workEnd: '18:00',
  }), {
    dailyGoalMl: 1800,
    workGoalMl: 1000,
    targetCups: 5,
  });

  const settings = calculateTargets({
    weightKg: 60,
    cupMl: 300,
    workStart: '09:00',
    workEnd: '17:00',
  });
  assert.equal(settings.dailyGoalMl, 1800);
  assert.equal(settings.workGoalMl, 900);
  assert.equal(settings.targetCups, 3);

  assert.equal(calculateTargets({
    weightKg: 60,
    cupMl: Number.POSITIVE_INFINITY,
    workStart: '09:00',
    workEnd: '18:00',
  }).targetCups, 1);
});

test('profile number checks are the shared weight, cup, and interval gate', () => {
  assert.equal(validateProfileNumbers(10, 200, 45).error, '体重请输入 30–300kg');
  assert.equal(validateProfileNumbers(60, 10, 45).error, '每次喝水量请输入 50–1000ml');
  assert.equal(validateProfileNumbers(60, 200, 0).error, '催水间隔请输入 1–1440 分钟的整数');
  assert.deepEqual(validateProfileNumbers(60.5, 250, '75'), {
    ok: true,
    weightKg: 60.5,
    cupMl: 250,
    intervalMin: 75,
  });
});

test('60kg over an 8 hour workday produces 1800ml daily and 900ml at work', () => {
  const result = calculateTargets({
    weightKg: 60,
    cupMl: 200,
    workStart: '09:15',
    workEnd: '17:15',
  });

  assert.equal(result.dailyGoalMl, 1800);
  assert.equal(result.workGoalMl, 900);
  assert.equal(result.targetCups, 5);
});

test('work target is rounded to 50ml and clamped to 800-1200ml', () => {
  assert.equal(calculateTargets({
    weightKg: 30,
    cupMl: 200,
    workStart: '09:00',
    workEnd: '17:00',
  }).workGoalMl, 800);

  assert.equal(calculateTargets({
    weightKg: 200,
    cupMl: 200,
    workStart: '09:00',
    workEnd: '18:00',
  }).workGoalMl, 1200);
});

test('target cups are recalculated from the reference goal and current cup capacity', () => {
  const result = calculateTargets({
    weightKg: 60,
    cupMl: 300,
    workStart: '09:00',
    workEnd: '17:00',
  });

  assert.equal(result.workGoalMl, 900);
  assert.equal(result.targetCups, 3);
});

test('DND validation rejects reversed and overlapping time ranges', () => {
  assert.equal(validateDndRanges([{ start: '13:00', end: '12:00' }]).ok, false);
  assert.equal(validateDndRanges([
    { start: '12:00', end: '13:00' },
    { start: '12:30', end: '14:00' },
  ]).ok, false);
  assert.equal(validateDndRanges([
    { start: '12:00', end: '13:00' },
    { start: '13:00', end: '14:00' },
  ]).ok, true);
});

test('profile validation rejects non-finite weight and cup values', () => {
  assert.equal(validateProfileInput({
    weightKg: Number.NaN,
    cupMl: 200,
    intervalMin: 45,
    workStart: '09:00',
    workEnd: '18:00',
    dndRanges: [],
  }).ok, false);
  assert.equal(validateProfileInput({
    weightKg: 60,
    cupMl: Number.POSITIVE_INFINITY,
    intervalMin: 45,
    workStart: '09:00',
    workEnd: '18:00',
    dndRanges: [],
  }).ok, false);
});

test('manual reminder interval accepts only whole minutes from 1 to 1440', () => {
  for (const value of [1, 45, 1440, '90']) {
    assert.deepEqual(validateIntervalMin(value), { ok: true, intervalMin: Number(value) });
  }

  for (const value of [0, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '']) {
    const result = validateIntervalMin(value);
    assert.equal(result.ok, false);
    assert.match(result.error, /1–1440/);
  }
});

test('profile validation returns the manual reminder interval', () => {
  const result = validateProfileInput({
    weightKg: 60,
    cupMl: 250,
    intervalMin: 75,
    workStart: '09:15',
    workEnd: '18:45',
    dndRanges: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile.intervalMin, 75);
  assert.equal(result.profile.workStart, '09:15');
  assert.equal(result.profile.workEnd, '18:45');
});

test('work hours require valid same-day minute clocks', () => {
  assert.deepEqual(validateWorkHours('09:15', '18:45'), {
    ok: true,
    workStart: '09:15',
    workEnd: '18:45',
  });

  for (const [start, end] of [
    ['18:00', '09:00'],
    ['09:00', '09:00'],
    ['9:00', '18:00'],
    ['09:60', '18:00'],
  ]) {
    const result = validateWorkHours(start, end);
    assert.equal(result.ok, false);
    assert.match(result.error, /结束时间必须晚于开始时间|HH:MM/);
  }
});

test('availability defers reminders to the end of DND', () => {
  const now = new Date(2026, 6, 27, 12, 30, 0, 0);
  const result = getReminderAvailability(now, {
    workStart: '09:00',
    workEnd: '18:00',
    weekend: false,
    dndRanges: [{ start: '12:00', end: '13:00' }],
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'dnd');
  assert.equal(result.resumeAt.getTime(), new Date(2026, 6, 27, 13, 0, 0, 0).getTime());
});

test('availability moves an after-hours Friday reminder to Monday morning', () => {
  const friday = new Date(2026, 6, 31, 19, 0, 0, 0);
  const result = getReminderAvailability(friday, {
    workStart: '09:15',
    workEnd: '18:45',
    weekend: false,
    dndRanges: [],
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'after');
  assert.equal(result.resumeAt.getTime(), new Date(2026, 7, 3, 9, 15, 0, 0).getTime());
});

test('availability honors exact work-minute boundaries', () => {
  const settings = {
    workStart: '09:15',
    workEnd: '18:45',
    weekend: false,
    dndRanges: [],
  };

  assert.equal(getReminderAvailability(new Date(2026, 6, 27, 9, 14), settings).reason, 'before');
  assert.equal(getReminderAvailability(new Date(2026, 6, 27, 9, 15), settings).allowed, true);
  assert.equal(getReminderAvailability(new Date(2026, 6, 27, 18, 44), settings).allowed, true);
  assert.equal(getReminderAvailability(new Date(2026, 6, 27, 18, 45), settings).reason, 'after');
});
