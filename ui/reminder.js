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
  closing = false;
  undoId = null;
  $('#btns').classList.remove('show');
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

async function act(action) {
  if (closing) return;
  if (action === 'drink') {
    clearTimers();
    $('#btns').classList.remove('show');
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
  await window.api.reminderAction(action);
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
  closing = false;
  undoId = null;
  $('#dialog').classList.remove('in', 'out');
  $('#btnUndo').style.display = '';
  $('#confirm').classList.remove('show');
}

window.addEventListener('DOMContentLoaded', () => {
  $('#btnDrink').addEventListener('click', () => act('drink'));
  $('#btnSnooze').addEventListener('click', () => act('snooze'));
  $('#btnClose').addEventListener('click', () => act('dismiss'));
  $('#btnUndo').addEventListener('click', undo);
  window.api.onReminder(show);
  window.api.onReminderCancel(cancel);
});
