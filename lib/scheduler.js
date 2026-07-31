'use strict';

const { getReminderAvailability, parseClock } = require('./hydration.js');

const SNOOZE_MINUTES = Object.freeze([5, 15, 30]);

function normalizeSnoozeMinutes(value) {
  return Number.isInteger(value) && SNOOZE_MINUTES.includes(value) ? value : null;
}

function crossedDndWhileAsleep(lastTickAt, now, ranges) {
  if (!lastTickAt) return false;
  const before = new Date(lastTickAt);
  if (
    before.getFullYear() !== now.getFullYear()
    || before.getMonth() !== now.getMonth()
    || before.getDate() !== now.getDate()
  ) {
    return false;
  }
  const beforeMinute = before.getHours() * 60 + before.getMinutes();
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  if (nowMinute <= beforeMinute) return false;
  return (ranges || []).some((range) => (
    beforeMinute < parseClock(range.end) && nowMinute > parseClock(range.start)
  ));
}

function decideTick({
  now,
  lastTickAt,
  nextAt,
  reminderVisible,
  goalDone,
  profileCompleted,
  pausedUntil,
  intervalMin,
  settings,
}) {
  const nowMs = now.getTime();
  const paused = Number(pausedUntil) > nowMs;
  const suppressed = !profileCompleted || goalDone || paused;

  if (suppressed) {
    return {
      fireReminder: false,
      hideReminder: !!reminderVisible,
      nextAt: null,
    };
  }

  const availability = getReminderAvailability(now, settings);
  if (!availability.allowed) {
    if (availability.reason === 'dnd') {
      const isDue = nextAt !== null && nextAt !== undefined && nowMs >= Number(nextAt);
      return {
        fireReminder: false,
        hideReminder: !!reminderVisible,
        nextAt: reminderVisible || isDue ? availability.resumeAt.getTime() : nextAt,
      };
    }

    return {
      fireReminder: false,
      hideReminder: !!reminderVisible,
      nextAt: null,
    };
  }

  if (
    reminderVisible
    && crossedDndWhileAsleep(lastTickAt, now, settings.dndRanges)
  ) {
    return {
      fireReminder: false,
      hideReminder: true,
      nextAt: nowMs,
    };
  }

  if (reminderVisible) {
    return {
      fireReminder: false,
      hideReminder: false,
      nextAt: null,
    };
  }

  if (nextAt === null || nextAt === undefined) {
    return {
      fireReminder: false,
      hideReminder: false,
      nextAt: nowMs + Number(intervalMin) * 60_000,
    };
  }

  if (nowMs >= Number(nextAt)) {
    return {
      fireReminder: true,
      hideReminder: false,
      nextAt: null,
    };
  }

  return {
    fireReminder: false,
    hideReminder: false,
    nextAt,
  };
}

module.exports = {
  SNOOZE_MINUTES,
  decideTick,
  normalizeSnoozeMinutes,
};
