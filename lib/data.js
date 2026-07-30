'use strict';

const UNDO_WINDOW_MS = 10_000;

const DEFAULT_SETTINGS = Object.freeze({
  intervalMin: 45,
  intervalMode: 'manual',
  weightKg: null,
  cupMl: 200,
  dndRanges: [{ start: '12:00', end: '13:00' }],
  sedentaryEnabled: true,
  workStart: '09:00',
  workEnd: '18:00',
  weekend: false,
  sound: true,
  autoLaunch: false,
});

function cloneDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    dndRanges: DEFAULT_SETTINGS.dndRanges.map((range) => ({ ...range })),
  };
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeNonNegativeNumber(value, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const normalized = Math.max(0, number);
  return integer ? Math.floor(normalized) : normalized;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function createDefaultDatabase(today) {
  return {
    schemaVersion: 3,
    profileCompleted: false,
    settings: cloneDefaultSettings(),
    date: today,
    drinkCount: 0,
    consumedMl: 0,
    lastDrinkAt: null,
    history: {},
  };
}

function normalizeWorkClock(value, fallback) {
  if (typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  const hours = Number(value);
  if (!Number.isFinite(hours)) return fallback;
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 0 || totalMinutes >= 24 * 60) return fallback;
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function migrateHistory(history, fromV1) {
  const migrated = {};
  for (const [date, value] of Object.entries(history || {})) {
    if (!isValidDateString(date)) continue;
    if (fromV1 && Number.isFinite(Number(value))) {
      const drinkCount = normalizeNonNegativeNumber(value, { integer: true });
      migrated[date] = {
        drinkCount,
        consumedMl: drinkCount * 250,
        estimated: true,
      };
    } else if (value && typeof value === 'object') {
      migrated[date] = {
        drinkCount: normalizeNonNegativeNumber(value.drinkCount, { integer: true }),
        consumedMl: normalizeNonNegativeNumber(value.consumedMl),
        ...(value.estimated === true ? { estimated: true } : {}),
      };
    }
  }
  return migrated;
}

function migrateDatabase(raw, today) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const schemaVersion = source.schemaVersion;
  if (
    schemaVersion !== undefined
    && schemaVersion !== 1
    && schemaVersion !== 2
    && schemaVersion !== 3
  ) {
    throw new Error(`不支持的数据版本：${String(schemaVersion)}`);
  }
  const fromV1 = schemaVersion === undefined || schemaVersion === 1;
  const migratedFromVersion = schemaVersion === 3 ? null : (fromV1 ? 1 : 2);
  const db = createDefaultDatabase(isValidDateString(source.date) ? source.date : today);

  db.settings = {
    ...db.settings,
    ...(source.settings || {}),
    intervalMode: 'manual',
    dndRanges: Array.isArray(source.settings && source.settings.dndRanges)
      ? source.settings.dndRanges.map(({ start, end }) => ({ start, end }))
      : db.settings.dndRanges,
    workStart: normalizeWorkClock(
      source.settings && source.settings.workStart,
      db.settings.workStart,
    ),
    workEnd: normalizeWorkClock(
      source.settings && source.settings.workEnd,
      db.settings.workEnd,
    ),
  };

  if (fromV1) {
    db.profileCompleted = false;
    db.drinkCount = normalizeNonNegativeNumber(source.cups, { integer: true });
    db.consumedMl = db.drinkCount * 250;
  } else {
    db.profileCompleted = source.profileCompleted === true;
    db.drinkCount = normalizeNonNegativeNumber(source.drinkCount, { integer: true });
    db.consumedMl = normalizeNonNegativeNumber(source.consumedMl);
  }

  db.lastDrinkAt = normalizeTimestamp(source.lastDrinkAt);
  db.history = migrateHistory(source.history, fromV1);

  return { db, migratedFromVersion };
}

function recordDrink(db, now, id) {
  const amountMl = Math.max(1, Number(db.settings.cupMl || 200));
  const undo = {
    id,
    amountMl,
    previousDrinkCount: db.drinkCount,
    previousConsumedMl: db.consumedMl,
    previousLastDrinkAt: db.lastDrinkAt,
    expiresAt: Number(now) + UNDO_WINDOW_MS,
  };

  db.drinkCount += 1;
  db.consumedMl += amountMl;
  db.lastDrinkAt = Number(now);
  undo.resultDrinkCount = db.drinkCount;
  undo.resultConsumedMl = db.consumedMl;
  undo.resultLastDrinkAt = db.lastDrinkAt;
  return undo;
}

function undoDrink(db, undo, id, now) {
  if (!undo || undo.id !== id) return { ok: false, reason: 'not-latest' };
  if (Number(now) > undo.expiresAt) return { ok: false, reason: 'expired' };
  if (
    db.drinkCount !== undo.resultDrinkCount
    || db.consumedMl !== undo.resultConsumedMl
    || db.lastDrinkAt !== undo.resultLastDrinkAt
  ) {
    return { ok: false, reason: 'not-latest' };
  }

  db.drinkCount = undo.previousDrinkCount;
  db.consumedMl = undo.previousConsumedMl;
  db.lastDrinkAt = undo.previousLastDrinkAt;
  return { ok: true, reason: null };
}

function resetToday(db, today = db.date) {
  const previous = {
    drinkCount: db.drinkCount,
    consumedMl: db.consumedMl,
    lastDrinkAt: db.lastDrinkAt,
  };
  if (db.date !== today) rolloverDay(db, today);
  db.drinkCount = 0;
  db.consumedMl = 0;
  db.lastDrinkAt = null;
  return previous;
}

function rolloverDay(db, newDate) {
  if (db.date && db.date !== newDate) {
    db.history[db.date] = {
      drinkCount: db.drinkCount,
      consumedMl: db.consumedMl,
    };
  }

  const keys = Object.keys(db.history).sort();
  while (keys.length > 60) delete db.history[keys.shift()];
  db.date = newDate;
  db.drinkCount = 0;
  db.consumedMl = 0;
  db.lastDrinkAt = null;
}

module.exports = {
  DEFAULT_SETTINGS,
  UNDO_WINDOW_MS,
  createDefaultDatabase,
  migrateDatabase,
  recordDrink,
  resetToday,
  rolloverDay,
  undoDrink,
};
