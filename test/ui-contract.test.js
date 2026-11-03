'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'ui', 'index.js'), 'utf8');
const reminderHtml = fs.readFileSync(path.join(root, 'ui', 'reminder.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('reminder confirmation uses the same status role as the main-window toast', () => {
  assert.match(indexHtml, /<div id="toast" role="status"/);
  assert.match(reminderHtml, /<div class="confirm" id="confirm" role="status">/);
});

test('renderer pages enforce a restrictive content security policy', () => {
  for (const html of [indexHtml, reminderHtml]) {
    assert.match(html, /<meta\s+http-equiv="Content-Security-Policy"/);
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      assert.equal(html.includes(directive), true, `missing CSP directive: ${directive}`);
    }
  }
});

test('renderer boundaries explicitly enable Electron isolation', () => {
  assert.equal((mainJs.match(/contextIsolation:\s*true/g) || []).length, 2);
  assert.equal((mainJs.match(/nodeIntegration:\s*false/g) || []).length, 2);
  assert.equal((mainJs.match(/sandbox:\s*true/g) || []).length, 2);
});

test('renderer preview uses the shared hydration script', () => {
  const vm = require('node:vm');
  const hydrationSource = fs.readFileSync(path.join(root, 'lib', 'hydration.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(root, 'ui', 'index.js'), 'utf8');
  assert.ok(
    indexHtml.indexOf('src="../lib/hydration.js"') < indexHtml.indexOf('src="index.js"'),
    'hydration.js must load before the renderer script',
  );
  for (const declaration of [
    'function parseClock(',
    'function validateRanges(',
    'function validateWorkHours(',
    'function validateProfileNumbers(',
    'function calculatePreview(',
  ]) {
    assert.equal(indexJs.includes(declaration), false, declaration);
  }
  assert.equal((indexJs.match(/calculateTargets\(\{/g) || []).length, 2);

  const elements = new Map();
  const element = (value = '') => ({ value, textContent: '' });
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
  };
  const context = vm.createContext({
    Array,
    Date,
    Math,
    Number,
    document,
    window: { addEventListener() {} },
  });
  vm.runInContext(hydrationSource, context, { filename: 'hydration.js' });
  vm.runInContext(`${indexSource}
this.__setState = (state) => { S = state; };
this.__setSetupRanges = (ranges) => { setupRanges = ranges; };
`, context, { filename: 'index.js' });

  document.querySelector('#setupWeight').value = '60';
  document.querySelector('#setupCup').value = '200';
  document.querySelector('#setupInterval').value = '45';
  document.querySelector('#setupStart').value = '09:00';
  document.querySelector('#setupEnd').value = '18:00';
  context.updateSetupPreview();
  assert.equal(document.querySelector('#setupError').textContent, '');
  assert.equal(document.querySelector('#previewDaily').textContent, '1800ml');
  assert.equal(document.querySelector('#previewWork').textContent, '1000ml');
  assert.equal(document.querySelector('#previewCups').textContent, '5杯');
  assert.equal(document.querySelector('#previewInterval').textContent, '45分钟');

  context.__setSetupRanges([{ start: '13:00', end: '12:00' }]);
  context.updateSetupPreview();
  assert.equal(document.querySelector('#setupError').textContent, '免打扰结束时间必须晚于开始时间');
  assert.equal(document.querySelector('#previewCups').textContent, '5杯');
  context.__setSetupRanges([{ start: '12:00', end: '13:00' }]);

  document.querySelector('#setupCup').value = 'Infinity';
  context.updateSetupPreview();
  assert.equal(document.querySelector('#setupError').textContent, '每次喝水量请输入 50–1000ml');
  assert.equal(document.querySelector('#previewCups').textContent, '5杯');

  document.querySelector('#setupCup').value = '200';
  context.__setSetupRanges([
    { start: '12:00', end: '13:00' },
    { start: '15:00', end: '16:00' },
  ]);
  context.updateSetupPreview();
  assert.equal(
    document.querySelector('#setupError').textContent,
    '首次设置最多添加两个免打扰时段，更多时段可稍后在课内设定中添加。',
  );
  assert.equal(document.querySelector('#previewCups').textContent, '5杯');

  context.__setSetupRanges([
    { start: '13:00', end: '12:00' },
    { start: '15:00', end: '16:00' },
  ]);
  context.updateSetupPreview();
  assert.equal(document.querySelector('#setupError').textContent, '免打扰结束时间必须晚于开始时间');

  context.__setSetupRanges([{ start: '12:00', end: '13:00' }]);
  context.updateSetupPreview();
  assert.equal(document.querySelector('#setupError').textContent, '');

  document.querySelector('#weightInput').value = '60';
  document.querySelector('#cupInput').value = '300';
  document.querySelector('#intervalInput').value = '45';
  document.querySelector('#selStart').value = '09:00';
  document.querySelector('#selEnd').value = '17:00';
  context.__setState({ drinkCount: 2 });
  context.updateSettingsPreview();
  assert.equal(document.querySelector('#settingsError').textContent, '');
  assert.equal(document.querySelector('#sumDaily').textContent, '1800ml');
  assert.equal(document.querySelector('#sumWork').textContent, '900ml');
  assert.equal(document.querySelector('#sumCups').textContent, '2/3杯');

  assert.equal(context.calculateTargets({
    weightKg: 60,
    cupMl: Number.POSITIVE_INFINITY,
    workStart: '09:00',
    workEnd: '18:00',
  }).targetCups, 1);
});

const COPY = require(path.join(root, 'ui', 'copy.js'));
const vm = require('node:vm');

function loadRenderer(filename) {
  const listeners = [];
  const elements = new Map();
  const element = () => ({
    value: '',
    textContent: '',
    inert: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener() {},
    setAttribute() {},
    focus() {},
  });
  const document = {
    addEventListener(type, listener, capture) {
      listeners.push({ type, listener, capture });
    },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    body: element(),
  };
  const calls = [];
  let context;
  const window = {
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    innerHeight: 900,
    api: {
      undoDrink(id) {
        const call = { id, pendingId: context.__undoId() };
        call.promise = new Promise((resolve) => { call.resolve = resolve; });
        calls.push(call);
        return call.promise;
      },
    },
  };
  let womps = 0;
  context = vm.createContext({
    Array,
    Date,
    Math,
    Number,
    Promise,
    document,
    window,
    COPY,
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame() {},
    Sound: {
      womp() { womps += 1; },
      setEnabled() {},
      click() {},
      drink() {},
      pop() {},
      fanfare() {},
      blip() {},
    },
  });
  const trailer = filename === 'index.js'
    ? `
      this.__setUndo = (id) => { toastUndoId = id; };
      this.__undoId = () => toastUndoId;
      this.__undo = () => undoFromToast();
      this.__text = () => document.querySelector('#toastText').textContent;
    `
    : `
      this.__setUndo = (id) => { undoId = id; closing = false; };
      this.__undoId = () => undoId;
      this.__undo = () => undo();
      this.__text = () => document.querySelector('#confirmText').textContent;
    `;
  vm.runInContext(
    `${fs.readFileSync(path.join(root, 'ui', filename), 'utf8')}\n${trailer}`,
    context,
    { filename },
  );
  return { context, listeners, calls, womps: () => womps };
}

test('repeated Enter on a button is ignored and does not move focus', () => {
  for (const filename of ['index.js', 'reminder.js']) {
    const { listeners } = loadRenderer(filename);
    const capture = listeners.filter((item) => item.type === 'keydown' && item.capture === true);
    assert.equal(capture.length, 1, filename);

    const button = {
      disabled: false,
      closest(selector) { return selector === 'button' ? button : null; },
      focus() { throw new Error('keydown moved focus'); },
    };
    const inside = { closest: (selector) => button.closest(selector) };
    const field = { closest() { return null; } };
    const fire = (target, repeat) => {
      const event = {
        repeat,
        target,
        prevented: false,
        stopped: false,
        preventDefault() { event.prevented = true; },
        stopPropagation() { event.stopped = true; },
      };
      capture[0].listener(event);
      return event;
    };

    const repeated = fire(button, true);
    const nested = fire(inside, true);
    const first = fire(button, false);
    const typed = fire(field, true);
    const bare = fire({}, true);
    assert.equal(repeated.prevented, true);
    assert.equal(repeated.stopped, false);
    assert.equal(nested.prevented, true);
    assert.equal(first.prevented, false);
    assert.equal(typed.prevented, false);
    assert.equal(bare.prevented, false);
    assert.equal(button.disabled, false);
  }
});

test('undo clears its id before the request and reports why it failed', async () => {
  assert.ok(
    reminderHtml.indexOf('src="copy.js"') < reminderHtml.indexOf('src="reminder.js"'),
    'reminder must load COPY before using the storage undo message',
  );
  const success = {
    'index.js': '已撤销刚才一杯，进度已经扣回。',
    'reminder.js': '已撤销，刚才那杯不计入进度。',
  };
  const failure = {
    expired: '撤销时间已过，本课已经归档。',
    'not-latest': '只能撤销最新的一杯。',
    storage: COPY.undoStorage,
  };

  for (const filename of ['index.js', 'reminder.js']) {
    const ui = loadRenderer(filename);
    ui.context.__setUndo('cup-1');
    const first = ui.context.__undo();
    const second = ui.context.__undo();
    assert.equal(ui.calls.length, 1, filename);
    assert.equal(ui.calls[0].id, 'cup-1');
    assert.equal(ui.calls[0].pendingId, null);
    ui.calls[0].resolve({ ok: true });
    await first;
    await second;
    assert.equal(ui.context.__text(), success[filename]);
    assert.equal(ui.womps(), 1);
    assert.equal(ui.calls.length, 1);

    for (const reason of ['expired', 'not-latest', 'storage']) {
      ui.context.__setUndo(`cup-${reason}`);
      const pending = ui.context.__undo();
      const call = ui.calls.at(-1);
      assert.equal(call.pendingId, null);
      call.resolve({ ok: false, reason });
      await pending;
      assert.equal(ui.context.__text(), failure[reason]);
    }
    assert.equal(ui.womps(), 1);

    const callsBeforeEmpty = ui.calls.length;
    await ui.context.__undo();
    assert.equal(ui.calls.length, callsBeforeEmpty);
  }
});
