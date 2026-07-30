'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseClock(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function calculateTargets({
  weightKg,
  cupMl,
  workStart,
  workEnd,
  consumedMl = 0,
  drinkCount = 0,
}) {
  const dailyGoalMl = Math.round(Number(weightKg) * 30);
  const startMin = parseClock(workStart);
  const endMin = parseClock(workEnd);
  const workMinutes = Math.max(0, (endMin ?? 0) - (startMin ?? 0));
  const rawWorkGoal = dailyGoalMl * workMinutes / (16 * 60);
  const workGoalMl = clamp(Math.round(rawWorkGoal / 50) * 50, 800, 1200);
  const targetCups = Math.max(1, Math.ceil(workGoalMl / Number(cupMl)));

  return {
    dailyGoalMl,
    workGoalMl,
    targetCups,
  };
}

function validateWorkHours(workStart, workEnd) {
  const startMin = parseClock(workStart);
  const endMin = parseClock(workEnd);
  if (startMin === null || endMin === null) {
    return { ok: false, error: '上下班时间请使用 HH:MM 格式' };
  }
  if (endMin <= startMin) {
    return { ok: false, error: '结束时间必须晚于开始时间' };
  }
  return { ok: true, workStart, workEnd };
}

function validateDndRanges(ranges) {
  if (!Array.isArray(ranges)) return { ok: false, error: '免打扰时段格式不正确' };
  const parsed = [];

  for (const range of ranges) {
    const startMin = parseClock(range && range.start);
    const endMin = parseClock(range && range.end);
    if (startMin === null || endMin === null || endMin <= startMin) {
      return { ok: false, error: '免打扰结束时间必须晚于开始时间' };
    }
    parsed.push({ ...range, startMin, endMin });
  }

  parsed.sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < parsed.length; i += 1) {
    if (parsed[i].startMin < parsed[i - 1].endMin) {
      return { ok: false, error: '免打扰时段不能重叠' };
    }
  }

  return {
    ok: true,
    ranges: parsed.map(({ start, end }) => ({ start, end })),
  };
}

function validateIntervalMin(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: false, error: '催水间隔请输入 1–1440 分钟的整数' };
  }
  const intervalMin = Number(value);
  if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) {
    return { ok: false, error: '催水间隔请输入 1–1440 分钟的整数' };
  }
  return { ok: true, intervalMin };
}

function validateProfileInput(input) {
  const weightKg = Number(input && input.weightKg);
  const cupMl = Number(input && input.cupMl);
  if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 300) {
    return { ok: false, error: '体重请输入 30–300kg' };
  }
  if (!Number.isFinite(cupMl) || cupMl < 50 || cupMl > 1000) {
    return { ok: false, error: '每次喝水量请输入 50–1000ml' };
  }
  const intervalValidation = validateIntervalMin(input && input.intervalMin);
  if (!intervalValidation.ok) return intervalValidation;
  const workValidation = validateWorkHours(input && input.workStart, input && input.workEnd);
  if (!workValidation.ok) return workValidation;
  const dndValidation = validateDndRanges(input && input.dndRanges);
  if (!dndValidation.ok) return dndValidation;
  return {
    ok: true,
    profile: {
      weightKg,
      cupMl,
      intervalMin: intervalValidation.intervalMin,
      workStart: workValidation.workStart,
      workEnd: workValidation.workEnd,
      dndRanges: dndValidation.ranges,
    },
  };
}

function isWorkday(date, weekend) {
  const day = date.getDay();
  return !!weekend || (day !== 0 && day !== 6);
}

function atMinutes(date, minutes) {
  const result = new Date(date);
  result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return result;
}

function nextWorkStart(date, settings, includeToday = false) {
  const result = new Date(date);
  result.setSeconds(0, 0);
  if (!includeToday) result.setDate(result.getDate() + 1);

  while (!isWorkday(result, settings.weekend)) result.setDate(result.getDate() + 1);
  return atMinutes(result, parseClock(settings.workStart));
}

function getReminderAvailability(date, settings) {
  const workStartMin = parseClock(settings.workStart);
  const workEndMin = parseClock(settings.workEnd);
  const minute = date.getHours() * 60 + date.getMinutes();

  if (workStartMin === null || workEndMin === null || workEndMin <= workStartMin) {
    return { allowed: false, reason: 'invalid', resumeAt: null };
  }

  if (!isWorkday(date, settings.weekend)) {
    return { allowed: false, reason: 'weekend', resumeAt: nextWorkStart(date, settings) };
  }
  if (minute < workStartMin) {
    return { allowed: false, reason: 'before', resumeAt: atMinutes(date, workStartMin) };
  }
  if (minute >= workEndMin) {
    return { allowed: false, reason: 'after', resumeAt: nextWorkStart(date, settings) };
  }

  const validation = validateDndRanges(settings.dndRanges || []);
  if (validation.ok) {
    for (const range of validation.ranges) {
      const startMin = parseClock(range.start);
      const endMin = parseClock(range.end);
      if (minute >= startMin && minute < endMin) {
        return { allowed: false, reason: 'dnd', resumeAt: atMinutes(date, endMin) };
      }
    }
  }

  return { allowed: true, reason: 'working', resumeAt: null };
}

module.exports = {
  calculateTargets,
  getReminderAvailability,
  parseClock,
  validateIntervalMin,
  validateProfileInput,
  validateDndRanges,
  validateWorkHours,
};
