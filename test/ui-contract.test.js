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
