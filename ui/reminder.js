// 水分補給課 · 催水弹窗（无限等待 + 短时撤销）
'use strict';

const $ = (selector) => document.querySelector(selector);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let typingTimer = null;
let startTimer = null;
let confirmTimer = null;
let countdownTimer = null;
let closing = false;
let undoId = null;
let drinking = false;

function snoozeOptions() {
  return [...document.querySelectorAll('.snooze-option')];
}

function closeSnoozeMenu(restoreFocus = false) {
  const menu = $('#snoozeMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('#btnSnooze').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('#btnSnooze').focus();
}

function openSnoozeMenu() {
  const menu = $('#snoozeMenu');
  menu.hidden = false;
  $('#btnSnooze').setAttribute('aria-expanded', 'true');
  snoozeOptions()[0]?.focus();
}

function toggleSnoozeMenu() {
  if ($('#snoozeMenu').hidden) openSnoozeMenu();
  else closeSnoozeMenu(true);
}

function handleSnoozeMenuKeydown(event) {
  const options = snoozeOptions();
  const current = options.indexOf(document.activeElement);
  let next = current;
  switch (event.key) {
    case 'ArrowDown':
      next = (current + 1) % options.length;
      break;
    case 'ArrowUp':
      next = (current - 1 + options.length) % options.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = options.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  options[next]?.focus();
}

function clearTimers() {
  clearInterval(typingTimer);
  clearTimeout(startTimer);
  clearTimeout(confirmTimer);
  clearInterval(countdownTimer);
}

function typewriter(text, done) {
  clearInterval(typingTimer);
  if (reducedMotion.matches) {
    $('#txt').textContent = text;
    $('#cursor').style.display = 'none';
    if (done) done();
    return;
  }
  $('#txt').textContent = '';
  $('#cursor').style.display = '';
  let index = 0;
  typingTimer = setInterval(() => {
    $('#txt').textContent = text.slice(0, ++index);
    if (index % 2 === 0) Sound.blip();
    if (index >= text.length) {
      clearInterval(typingTimer);
      $('#cursor').style.display = 'none';
      if (done) done();
    }
  }, 38);
}

function resetView() {
  clearTimers();
  closeSnoozeMenu();
  closing = false;
  undoId = null;
  drinking = false;
  $('#btns').classList.remove('show');
  $('#btns').inert = true;
  $('#meta').classList.remove('show');
  $('#confirm').classList.remove('show');
  $('#btnUndo').style.display = '';
  $('#undoCount').textContent = '6s';
  $('#dialog').classList.remove('out');
}

function show(payload) {
  resetView();
  Sound.setEnabled(payload.sound);
  $('#cupTip').textContent = `💧 本次 ${payload.cupMl}ml`;
  $('#btnDrink').textContent = `喝了！（+${payload.cupMl}ml）`;
  $('#walkTip').style.display = payload.sedentaryEnabled ? '' : 'none';

  const dialog = $('#dialog');
  void dialog.offsetWidth;
  dialog.classList.add('in');
  Sound.pop();
  startTimer = setTimeout(() => {
    typewriter(payload.text, () => {
      $('#meta').classList.add('show');
      $('#btns').classList.add('show');
      $('#btns').inert = false;
    });
  }, reducedMotion.matches ? 0 : 380);
}

function finishClose(delay = 320) {
  closing = true;
  clearTimers();
  $('#dialog').classList.remove('in');
  $('#dialog').classList.add('out');
  setTimeout(() => window.api.reminderDone(), reducedMotion.matches ? 0 : delay);
}

async function act(action, snoozeMinutes) {
  if (closing) return;
  if (action === 'drink') {
    if (drinking) return;
    drinking = true;
    clearTimers();
    $('#btns').classList.remove('show');
    $('#btns').inert = true;
    const result = await window.api.reminderAction('drink');
    if (!result.ok) {
      $('#confirmText').textContent = result.error || '本次记录失败，请检查数据目录。';
      $('#btnUndo').style.display = 'none';
      $('#undoCount').textContent = '';
      $('#confirm').classList.add('show');
      confirmTimer = setTimeout(() => finishClose(260), 2600);
      return;
    }
    Sound.drink();
    undoId = result.undoId;
    $('#confirmText').textContent = `已记录 ${result.cupMl}ml。喝水之后，肩膀也松一松。`;
    $('#confirm').classList.add('show');
    let seconds = 6;
    $('#undoCount').textContent = `${seconds}s`;
    countdownTimer = setInterval(() => {
      seconds -= 1;
      $('#undoCount').textContent = `${Math.max(0, seconds)}s`;
    }, 1000);
    confirmTimer = setTimeout(() => finishClose(280), 6000);
    return;
  }

  if (action === 'snooze') Sound.womp();
  const result = await window.api.reminderAction(action, snoozeMinutes);
  if (result?.ok === false) return;
  finishClose();
}

async function undo() {
  if (!undoId || closing) return;
  clearTimers();
  const result = await window.api.undoDrink(undoId);
  undoId = null;
  if (result.ok) {
    Sound.womp();
    $('#confirmText').textContent = '已撤销，刚才那杯不计入进度。';
    $('#btnUndo').style.display = 'none';
    $('#undoCount').textContent = '';
    confirmTimer = setTimeout(() => finishClose(260), 900);
  } else {
    $('#confirmText').textContent = '撤销时间已过，本课已经归档。';
    confirmTimer = setTimeout(() => finishClose(260), 1100);
  }
}

function cancel() {
  clearTimers();
  closeSnoozeMenu();
  closing = false;
  undoId = null;
  $('#dialog').classList.remove('in', 'out');
  $('#btnUndo').style.display = '';
  $('#confirm').classList.remove('show');
}

window.addEventListener('DOMContentLoaded', () => {
  $('#btnDrink').addEventListener('click', () => act('drink'));
  $('#btnSnooze').addEventListener('click', toggleSnoozeMenu);
  $('#snoozeMenu').addEventListener('keydown', handleSnoozeMenuKeydown);
  for (const option of snoozeOptions()) {
    option.addEventListener('click', () => {
      const minutes = Number(option.dataset.minutes);
      closeSnoozeMenu();
      act('snooze', minutes);
    });
  }
  document.addEventListener('click', (event) => {
    if (!$('#snoozeWrap').contains(event.target)) closeSnoozeMenu();
  });
  $('#snoozeWrap').addEventListener('focusout', (event) => {
    if ($('#snoozeWrap').contains(event.relatedTarget)) return;
    closeSnoozeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#snoozeMenu').hidden) {
      event.preventDefault();
      closeSnoozeMenu(true);
    }
  });
  $('#btnClose').addEventListener('click', () => act('dismiss'));
  $('#btnUndo').addEventListener('click', undo);
  window.api.onReminder(show);
  window.api.onReminderCancel(cancel);
});
