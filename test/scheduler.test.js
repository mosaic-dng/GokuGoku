'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideTick } = require('../lib/scheduler.js');

const settings = {
  workStart: '09:15',
  workEnd: '18:45',
  weekend: false,
  dndRanges: [{ start: '12:00', end: '13:00' }],
};

function tickAt(hours, minutes, overrides = {}) {
  const now = new Date(2026, 6, 27, hours, minutes, 0, 0);
  return decideTick({
    now,
    nextAt: now.getTime() - 1,
    reminderVisible: false,
    goalDone: false,
    profileCompleted: true,
    pausedUntil: null,
    intervalMin: 45,
    settings,
    ...overrides,
  });
}

test('a due reminder fires once and leaves no next timer while visible', () => {
  const due = tickAt(10, 0);
  assert.equal(due.fireReminder, true);
  assert.equal(due.nextAt, null);

  const stillVisible = tickAt(10, 50, { nextAt: null, reminderVisible: true });
  assert.equal(stillVisible.fireReminder, false);
  assert.equal(stillVisible.hideReminder, false);
  assert.equal(stillVisible.nextAt, null);
});

test('a due reminder during DND is deferred to DND end', () => {
  const result = tickAt(12, 30);

  assert.equal(result.fireReminder, false);
  assert.equal(result.hideReminder, false);
  assert.equal(result.nextAt, new Date(2026, 6, 27, 13, 0, 0, 0).getTime());
});

test('DND start hides a visible reminder and keeps it due for DND end', () => {
  const result = tickAt(12, 0, { reminderVisible: true, nextAt: null });

  assert.equal(result.hideReminder, true);
  assert.equal(result.nextAt, new Date(2026, 6, 27, 13, 0, 0, 0).getTime());
});

test('waking after an entire DND still replaces the stale visible reminder', () => {
  const result = tickAt(13, 5, {
    reminderVisible: true,
    nextAt: null,
    lastTickAt: new Date(2026, 6, 27, 11, 55, 0, 0).getTime(),
  });

  assert.equal(result.hideReminder, true);
  assert.equal(result.fireReminder, false);
  assert.equal(result.nextAt, new Date(2026, 6, 27, 13, 5, 0, 0).getTime());
});

test('work end hides a visible reminder and clears its timer', () => {
  const result = tickAt(18, 45, { reminderVisible: true, nextAt: null });

  assert.equal(result.hideReminder, true);
  assert.equal(result.nextAt, null);
});

test('first tick in an eligible work period schedules a full interval', () => {
  const result = tickAt(9, 15, { nextAt: null });

  assert.equal(result.fireReminder, false);
  assert.equal(result.nextAt, new Date(2026, 6, 27, 10, 0, 0, 0).getTime());
});

test('a reminder is suppressed at the exact minute work ends', () => {
  const result = tickAt(18, 45);

  assert.equal(result.fireReminder, false);
  assert.equal(result.nextAt, null);
});

test('pause and completed profile suppress and hide reminders', () => {
  const paused = tickAt(10, 0, {
    reminderVisible: true,
    pausedUntil: new Date(2026, 6, 27, 11, 0, 0, 0).getTime(),
  });
  assert.equal(paused.hideReminder, true);
  assert.equal(paused.nextAt, null);

  const incomplete = tickAt(10, 0, { profileCompleted: false });
  assert.equal(incomplete.fireReminder, false);
  assert.equal(incomplete.nextAt, null);
});
