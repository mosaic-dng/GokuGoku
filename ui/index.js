// 水分補給課 · 主面板逻辑
'use strict';

const $ = (selector) => document.querySelector(selector);
const pick = (items) => items[Math.floor(Math.random() * items.length)];

let S = null;
let lastCups = -1;
let toastTimer = null;
let toastUndoId = null;
let settingsRanges = [];
let setupRanges = [{ start: '12:00', end: '13:00' }];
let settingsDraftReady = false;
let setupDraftReady = false;
let intervalDraftDirty = false;
let setupStep = 1;
let goldShown = false;
let shownStorageError = null;

/* ---------- 小杯子 ---------- */
function cupSVG(filled) {
  return `<svg viewBox="0 0 24 28" width="32" height="38" aria-hidden="true">
    <path d="M4,3 L6.2,24 Q6.5,25.8 8.3,25.8 L15.7,25.8 Q17.5,25.8 17.8,24 L20,3"
      fill="#fffdf4" stroke="#9f927d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${filled ? `<path d="M6.1,10 L7.5,23.2 Q7.7,24.3 8.8,24.3 L15.2,24.3 Q16.3,24.3 16.5,23.2 L17.9,10 Q14,12 12,10 T6.1,10"
      fill="#3dd4c6" opacity="0.92"/>` : ''}
    <path d="M4,3 L20,3" stroke="#9f927d" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function renderCups() {
  const box = $('#cups');
  const total = Math.max(S.targetCups, S.drinkCount);
  const signature = `${S.drinkCount}/${total}`;
  if (box.dataset.sig === signature) return;
  box.innerHTML = Array.from({ length: total }, (_, index) => cupSVG(index < S.drinkCount)).join('');
  box.dataset.sig = signature;
  if (S.drinkCount > lastCups && lastCups >= 0) {
    const cup = box.children[S.drinkCount - 1];
    if (cup) cup.classList.add('pop');
  }
}

function renderTitle() {
  const percentage = S.workGoalMl ? S.consumedMl / S.workGoalMl : 0;
  let title = COPY.titles[0].text;
  for (const item of COPY.titles) if (percentage >= item.pct) title = item.text;
  $('#title').textContent = title;
  $('#title').classList.toggle('hot', percentage < 1);
}

function renderFace() {
  const mode = S.goalDone ? 'happy' : (S.overdue || S.reminderActive ? 'thirsty' : 'normal');
  $('#mascot').querySelectorAll('.face').forEach((face) => {
    face.style.display = 'none';
  });
  $('#mascot').querySelector(`.f-${mode}`).style.display = '';
}

/* ---------- 状态与倒计时 ---------- */
function fmtClock(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderTimer() {
  const label = $('#timerLabel');
  const value = $('#timerVal');
  const pulse = $('#pulse');
  value.textContent = '';
  pulse.style.background = 'var(--mint)';

  if (S.profileRequired) {
    label.textContent = '完成入课设置后，本课开始执勤';
    pulse.style.background = 'var(--orange)';
  } else if (S.paused) {
    label.textContent = `静音潜伏中 · ${fmtClock(S.pausedUntil)} 恢复`;
    pulse.style.background = 'var(--faint)';
  } else if (S.goalDone) {
    label.textContent = COPY.status.goalDone;
    pulse.style.background = 'var(--yellow)';
  } else if (S.offReason === 'dnd') {
    label.textContent = `免打扰中 · ${fmtClock(S.resumeAt)} 恢复催水`;
    pulse.style.background = 'var(--blue)';
  } else if (!S.working) {
    label.textContent = S.offReason === 'weekend'
      ? COPY.status.weekend
      : (S.offReason === 'before' ? COPY.status.beforeWork : COPY.status.offDuty);
    pulse.style.background = 'var(--faint)';
  } else if (S.reminderActive) {
    label.textContent = '催水使者已到 · 等你手动确认';
    pulse.style.background = 'var(--orange)';
  } else if (S.nextAt) {
    const remaining = Math.max(0, Math.round((S.nextAt - S.now) / 1000));
    if (remaining <= 0) {
      label.textContent = COPY.status.overdue;
    } else {
      label.textContent = COPY.status.counting;
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      value.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
  } else {
    label.textContent = '本课正在安排下一次巡逻';
  }
}

/* ---------- 目标预览 ---------- */
function validationMessage(result) {
  return result.ok ? '' : result.error;
}

function renderProgress() {
  const progress = $('#progressBar');
  const percentage = Math.min(100, Math.max(0, Math.round(
    S.workGoalMl ? S.consumedMl / S.workGoalMl * 100 : 0,
  )));
  progress.style.width = `${percentage}%`;
  progress.setAttribute('aria-valuenow', String(percentage));
}

function showDrinkFeedback(previousCups) {
  if (previousCups < 0 || S.drinkCount <= previousCups) return;
  const count = $('#cupNum');
  const mascot = $('#mascotBox');
  count.classList.remove('count-bump');
  mascot.classList.remove('boing');
  void count.offsetWidth;
  count.classList.add('count-bump');
  mascot.classList.add('boing');
}

function updateSetupPreview() {
  if (S && S.storageError) {
    $('#setupError').textContent = S.storageError;
    return;
  }
  const weight = Number($('#setupWeight').value);
  const cup = Number($('#setupCup').value);
  const interval = Number($('#setupInterval').value);
  const workStart = $('#setupStart').value;
  const workEnd = $('#setupEnd').value;
  const numericError = validationMessage(validateProfileNumbers(weight, cup, interval));
  const workError = validationMessage(validateWorkHours(workStart, workEnd));
  $('#setupError').textContent = numericError || workError || validationMessage(validateDndRanges(setupRanges));
  if (numericError || workError) return;
  const preview = calculateTargets({ weightKg: weight, cupMl: cup, workStart, workEnd });
  $('#previewDaily').textContent = `${preview.dailyGoalMl}ml`;
  $('#previewWork').textContent = `${preview.workGoalMl}ml`;
  $('#previewCups').textContent = `${preview.targetCups}杯`;
  $('#previewInterval').textContent = `${interval}分钟`;
}

function updateSettingsPreview() {
  if (S && S.storageError) {
    $('#settingsError').textContent = S.storageError;
    return;
  }
  if (!S) return;
  const weight = Number($('#weightInput').value);
  const cup = Number($('#cupInput').value);
  const interval = Number($('#intervalInput').value);
  const workStart = $('#selStart').value;
  const workEnd = $('#selEnd').value;
  const numericError = validationMessage(validateProfileNumbers(weight, cup, interval));
  const workError = validationMessage(validateWorkHours(workStart, workEnd));
  $('#settingsError').textContent = numericError || workError || validationMessage(validateDndRanges(settingsRanges));
  if (numericError || workError) return;
  const preview = calculateTargets({ weightKg: weight, cupMl: cup, workStart, workEnd });
  $('#sumDaily').textContent = `${preview.dailyGoalMl}ml`;
  $('#sumWork').textContent = `${preview.workGoalMl}ml`;
  $('#sumCups').textContent = `${S.drinkCount}/${preview.targetCups}杯`;
}

/* ---------- 免打扰编辑器 ---------- */
function renderDndEditor(container, ranges, onChange) {
  container.replaceChildren();
  ranges.forEach((range, index) => {
    const row = document.createElement('div');
    row.className = 'dnd-row';
    const startInput = document.createElement('input');
    startInput.type = 'time';
    startInput.step = '900';
    startInput.setAttribute('aria-label', '免打扰开始');
    startInput.value = range.start;
    const separator = document.createElement('span');
    separator.textContent = '—';
    const endInput = document.createElement('input');
    endInput.type = 'time';
    endInput.step = '900';
    endInput.setAttribute('aria-label', '免打扰结束');
    endInput.value = range.end;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove-range';
    removeButton.title = '删除这一段';
    removeButton.setAttribute('aria-label', '删除这一段免打扰时段');
    removeButton.textContent = '×';

    startInput.addEventListener('input', () => {
      ranges[index].start = startInput.value;
      onChange();
    });
    endInput.addEventListener('input', () => {
      ranges[index].end = endInput.value;
      onChange();
    });
    removeButton.addEventListener('click', () => {
      ranges.splice(index, 1);
      renderDndEditor(container, ranges, onChange);
      onChange();
    });
    row.append(startInput, separator, endInput, removeButton);
    container.appendChild(row);
  });
}

function addRange(ranges, container, onChange) {
  ranges.push({ start: '15:00', end: '16:00' });
  renderDndEditor(container, ranges, onChange);
  onChange();
}

/* ---------- 设置控件 ---------- */
function syncControlValue(control, value) {
  const nextValue = String(value);
  if (document.activeElement !== control && control.value !== nextValue) control.value = nextValue;
}

function setSetupStep(step) {
  setupStep = step === 2 ? 2 : 1;
  $('.setup-card').dataset.step = String(setupStep);
  $('#setupStepLabel').textContent = setupStep === 1 ? '第 1 步 · 个人课表' : '第 2 步 · 免打扰与目标';
}

function applySetupMode() {
  const compact = window.innerHeight < 800;
  $('#onboarding').classList.toggle('compact', compact);
  if (!compact) setSetupStep(1);
}

function addSetupRange() {
  if (setupRanges.length >= 2) {
    $('#setupError').textContent = '首次设置最多添加两个免打扰时段，更多时段可稍后在课内设定中添加。';
    return;
  }
  addRange(setupRanges, $('#setupDnd'), updateSetupPreview);
}

function bindSwitch(selector, key) {
  const control = $(selector);
  control.addEventListener('click', () => {
    Sound.click();
    window.api.setSetting(key, !control.classList.contains('on'));
  });
}

function syncSwitch(selector, enabled) {
  const control = $(selector);
  control.classList.toggle('on', !!enabled);
  control.setAttribute('aria-pressed', String(!!enabled));
}

/* ---------- Toast 与撤销 ---------- */
function hideToast() {
  $('#toast').classList.remove('show', 'has-action', 'gold');
  toastUndoId = null;
}

function toast(message, { gold = false, undoId = null, duration = 4200 } = {}) {
  $('#toastText').textContent = message;
  $('#toast').classList.toggle('gold', gold);
  $('#toast').classList.toggle('has-action', !!undoId);
  $('#toast').classList.add('show');
  toastUndoId = undoId;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

async function undoFromToast() {
  if (!toastUndoId) return;
  const result = await window.api.undoDrink(toastUndoId);
  if (result.ok) {
    Sound.womp();
    toast('已撤销刚才一杯，进度已经扣回。');
  } else {
    toast(result.reason === 'expired' ? '撤销时间已过，本课已经归档。' : '只能撤销最新的一杯。');
  }
}

/* ---------- 状态渲染 ---------- */
function newQuote() {
  $('#quote').textContent = pick(COPY.idle);
}

function populateSettingsDraft(profile) {
  $('#weightInput').value = profile.weightKg || 60;
  $('#cupInput').value = profile.cupMl || 200;
  $('#intervalInput').value = profile.intervalMin || 45;
  $('#selStart').value = profile.workStart || '09:00';
  $('#selEnd').value = profile.workEnd || '18:00';
  settingsRanges = (profile.dndRanges || []).map((range) => ({ ...range }));
  renderDndEditor($('#settingsDnd'), settingsRanges, updateSettingsPreview);
  settingsDraftReady = true;
}

function syncProfileDraft(state) {
  if (!settingsDraftReady) {
    populateSettingsDraft(state);
  }
  if (!setupDraftReady) {
    $('#setupWeight').value = state.weightKg || 60;
    $('#setupCup').value = state.cupMl || 200;
    $('#setupInterval').value = state.intervalMin || 45;
    $('#setupStart').value = state.workStart || '09:00';
    $('#setupEnd').value = state.workEnd || '18:00';
    setupRanges = state.dndRanges.map((range) => ({ ...range }));
    renderDndEditor($('#setupDnd'), setupRanges, updateSetupPreview);
    setupDraftReady = true;
  }
}

function render(state) {
  const previousCups = S ? S.drinkCount : -1;
  S = state;
  Sound.setEnabled(S.sound);
  syncProfileDraft(state);

  $('#onboarding').classList.toggle('show', S.profileRequired);
  if (S.storageError) $('#setupError').textContent = S.storageError;
  $('#drinkBtn').disabled = !!S.storageError || S.profileRequired;
  if (S.storageError && shownStorageError !== S.storageError) {
    shownStorageError = S.storageError;
    toast(S.storageError, { duration: 30_000 });
  }
  $('#cupNum').textContent = S.drinkCount;
  $('#goalNum').textContent = S.targetCups;
  $('#drinkBtn').textContent = `喝了喝了！（+${S.cupMl}ml）`;
  renderCups();
  renderProgress();
  renderTitle();
  renderFace();
  renderTimer();
  showDrinkFeedback(previousCups);

  if (!intervalDraftDirty) syncControlValue($('#intervalInput'), S.intervalMin);
  syncSwitch('#swSedentary', S.sedentaryEnabled);
  syncSwitch('#swWeekend', S.weekend);
  syncSwitch('#swSound', S.sound);
  syncSwitch('#swAuto', S.autoLaunch);
  updateSetupPreview();
  updateSettingsPreview();

  if (previousCups >= 0 && S.drinkCount > previousCups && S.goalDone && !goldShown) {
    goldShown = true;
    Sound.fanfare();
  }
  if (S.drinkCount === 0) goldShown = false;
  lastCups = S.drinkCount;
}

/* ---------- 保存 ---------- */
async function submitProfile(mode) {
  const setup = mode === 'setup';
  const weight = Number($(setup ? '#setupWeight' : '#weightInput').value);
  const cup = Number($(setup ? '#setupCup' : '#cupInput').value);
  const interval = Number($(setup ? '#setupInterval' : '#intervalInput').value);
  const workStart = $(setup ? '#setupStart' : '#selStart').value;
  const workEnd = $(setup ? '#setupEnd' : '#selEnd').value;
  const ranges = setup ? setupRanges : settingsRanges;
  const errorNode = $(setup ? '#setupError' : '#settingsError');
  const validation = validateProfileInput({
    weightKg: weight,
    cupMl: cup,
    intervalMin: interval,
    workStart,
    workEnd,
    dndRanges: ranges,
  });
  if (!validation.ok) {
    errorNode.textContent = validation.error;
    return;
  }

  const result = await window.api.saveProfile({
    weightKg: weight,
    cupMl: cup,
    intervalMin: interval,
    workStart,
    workEnd,
    dndRanges: ranges,
  });
  if (!result.ok) {
    errorNode.textContent = result.error;
    return;
  }
  errorNode.textContent = '';
  if (setup) {
    populateSettingsDraft({
      weightKg: weight,
      cupMl: cup,
      intervalMin: interval,
      workStart,
      workEnd,
      dndRanges: ranges,
    });
    Sound.fanfare();
    toast('入课手续完成！水滴君正式上岗。', { gold: true });
  } else {
    if ($('#intervalInput').value === String(interval)) intervalDraftDirty = false;
    toast('个人设定已保存，课表重新计算完毕。');
  }
}

async function saveManualInterval() {
  const control = $('#intervalInput');
  const submittedValue = control.value;
  const interval = Number(submittedValue);
  const weight = Number($('#weightInput').value);
  const cup = Number($('#cupInput').value);
  const numericError = validationMessage(validateProfileNumbers(weight, cup, interval));
  if (numericError) {
    $('#settingsError').textContent = numericError;
    return;
  }

  const result = await window.api.setSetting('intervalMin', interval);
  if (!result.ok) {
    $('#settingsError').textContent = result.error || '催水间隔保存失败';
    return;
  }
  if (control.value === submittedValue) intervalDraftDirty = false;
  $('#settingsError').textContent = validationMessage(validateDndRanges(settingsRanges));
}

/* ---------- 事件 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => document.body.classList.add('ui-ready'));
  applySetupMode();
  window.addEventListener('resize', applySetupMode);
  bindSwitch('#swSedentary', 'sedentaryEnabled');
  bindSwitch('#swWeekend', 'weekend');
  bindSwitch('#swSound', 'sound');
  bindSwitch('#swAuto', 'autoLaunch');
  newQuote();
  setInterval(newQuote, 50_000);

  $('#drinkBtn').addEventListener('click', async () => {
    const result = await window.api.drink();
    if (!result.ok) {
      toast(result.error || '本次记录失败，请稍后重试。', { duration: 10_000 });
      return;
    }
    Sound.drink();
    const message = result.goalDone ? pick(COPY.goalDone) : pick(COPY.drinkAck);
    toast(message, { gold: result.goalDone, undoId: result.undoId, duration: 10_000 });
  });
  $('#toastAction').addEventListener('click', undoFromToast);

  $('#mascotBox').addEventListener('click', () => {
    const box = $('#mascotBox');
    box.classList.remove('boing');
    void box.offsetWidth;
    box.classList.add('boing');
    Sound.pop();
    newQuote();
  });

  $('#collapseHead').addEventListener('click', () => {
    Sound.click();
    const open = $('#settings').classList.toggle('open');
    window.api.setExpand(open);
  });
  $('#weightInput').addEventListener('input', updateSettingsPreview);
  $('#cupInput').addEventListener('input', updateSettingsPreview);
  $('#intervalInput').addEventListener('input', () => {
    intervalDraftDirty = true;
    updateSettingsPreview();
  });
  $('#intervalInput').addEventListener('change', saveManualInterval);
  $('#setupWeight').addEventListener('input', updateSetupPreview);
  $('#setupCup').addEventListener('input', updateSetupPreview);
  $('#setupInterval').addEventListener('input', updateSetupPreview);
  $('#setupStart').addEventListener('input', updateSetupPreview);
  $('#setupEnd').addEventListener('input', updateSetupPreview);
  $('#selStart').addEventListener('input', updateSettingsPreview);
  $('#selEnd').addEventListener('input', updateSettingsPreview);
  $('#settingsAddDnd').addEventListener('click', () => addRange(settingsRanges, $('#settingsDnd'), updateSettingsPreview));
  $('#setupAddDnd').addEventListener('click', addSetupRange);
  $('#setupNext').addEventListener('click', () => {
    const error = validationMessage(validateProfileNumbers(
      Number($('#setupWeight').value),
      Number($('#setupCup').value),
      Number($('#setupInterval').value),
    )) || validationMessage(validateWorkHours($('#setupStart').value, $('#setupEnd').value));
    $('#setupProfileError').textContent = error;
    if (!error) setSetupStep(2);
  });
  $('#setupBack').addEventListener('click', () => setSetupStep(1));
  $('#saveProfileBtn').addEventListener('click', () => submitProfile('settings'));
  $('#resetTodayBtn').addEventListener('click', async () => {
    const confirmed = window.confirm('确认清空今天的饮水记录吗？此操作不能撤销。');
    if (!confirmed) return;
    const result = await window.api.resetToday();
    if (!result.ok) {
      toast(result.error || '重置失败，请稍后重试。', { duration: 10_000 });
      return;
    }
    toast('今日饮水记录已重置。');
  });
  $('#setupSubmit').addEventListener('click', () => submitProfile('setup'));

  $('#btnMin').addEventListener('click', () => window.api.winMin());
  $('#btnHide').addEventListener('click', () => window.api.winHide());

  window.api.onState(render);
  window.api.getState().then(render);
});
