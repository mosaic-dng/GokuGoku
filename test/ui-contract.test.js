'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'ui', 'index.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'ui', 'style.css'), 'utf8');
const reminderHtml = fs.readFileSync(path.join(root, 'ui', 'reminder.html'), 'utf8');
const reminderJs = fs.readFileSync(path.join(root, 'ui', 'reminder.js'), 'utf8');
const hydrationJs = fs.readFileSync(path.join(root, 'lib', 'hydration.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const shotModeJs = fs.readFileSync(path.join(root, 'scripts', 'shot-mode.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const legacyTerms = {
  segmentedInterval: `seg${'Interval'}`,
  cupCapacity: `杯${'容量'}`,
  perCupCapacity: `每杯${'容量'}`,
  intervalModeAutoSetter: `setSetting('intervalMode', '${['a', 'u', 't', 'o'].join('')}')`,
  supportedIntervals: `SUPPORTED_${'INTERVALS'}`,
  legacyRecommendation: `recommended${'Interval'}`,
  intervalOptions: `INTERVAL_${'OPTIONS'}`,
  legacyRefresh: `refreshAutomatic${'Interval'}`,
};

test('main UI keeps the original bundled rounded font stack', () => {
  assert.match(
    styleCss,
    /--font:\s*'Nunito',\s*'Yuanti SC',\s*'PingFang SC',\s*'Microsoft YaHei UI',\s*'Microsoft YaHei',\s*sans-serif/,
  );
});

test('main window shell has only a crisp outline and no clipped drop shadow', () => {
  const windowRule = styleCss.match(/\.window\s*\{([^}]*)\}/s);
  assert.ok(windowRule, 'main window shell rule must exist');
  assert.match(windowRule[1], /box-shadow:\s*0 0 0 1px rgba\(121,\s*79,\s*39,\s*0\.10\)/);
  assert.doesNotMatch(windowRule[1], /0 10px 28px/);
});

test('main UI removes the requested helper copy and uses the new footer', () => {
  for (const removed of [
    `自动按${'目标均匀排课，也可手动指定'}`,
    '手动指定',
    '推荐 90 分钟',
    `使用${'推荐'}`,
    '时段之外绝不提示',
    '会议、午休期间不弹窗',
    '容量修改只影响之后的打卡',
    '上班建议',
    '简易饮水参考',
    '非医疗建议',
  ]) {
    assert.equal(indexHtml.includes(removed), false, `unexpected copy: ${removed}`);
  }
  assert.match(indexHtml, /本课对口渴负全部责任 · © 水分補給課/);
});

test('main footer has no decorative wave', () => {
  assert.doesNotMatch(indexHtml, /class="waves"/);
  assert.doesNotMatch(indexHtml, /\.footer \.waves/);
});

test('profile and interval settings use direct numeric entry with new terminology', () => {
  assert.match(indexHtml, /id="weightInput"\s+type="number"/);
  assert.match(indexHtml, /id="cupInput"\s+type="number"/);
  assert.match(indexHtml, /id="intervalInput"[^>]*type="number"[^>]*min="1"[^>]*max="1440"[^>]*step="1"/);
  assert.match(indexHtml, /id="setupInterval"[^>]*type="number"[^>]*min="1"[^>]*max="1440"[^>]*step="1"/);
  assert.match(indexHtml, /id="intervalInput"[^>]*aria-label="催水间隔（分钟）"/);
  assert.match(indexHtml, /id="selStart"[^>]*type="time"[^>]*step="60"[^>]*aria-label="上班开始时间"/);
  assert.match(indexHtml, /id="selEnd"[^>]*type="time"[^>]*step="60"[^>]*aria-label="上班结束时间"/);
  assert.match(indexHtml, /id="setupStart"[^>]*type="time"[^>]*step="60"[^>]*value="09:00"/);
  assert.match(indexHtml, /id="setupEnd"[^>]*type="time"[^>]*step="60"[^>]*value="18:00"/);
  assert.equal(indexHtml.includes(`id="${legacyTerms.segmentedInterval}"`), false);
  assert.equal(indexHtml.includes(legacyTerms.cupCapacity), false);
  assert.equal(indexHtml.includes(legacyTerms.perCupCapacity), false);
  assert.match(indexHtml, /每次喝水量（ml）/);
  assert.equal(indexJs.includes(legacyTerms.intervalModeAutoSetter), false);
  assert.doesNotMatch(indexJs, /buildIntervalButtons/);
  assert.doesNotMatch(indexJs, /syncIntervalButtons/);
  assert.match(
    indexJs,
    /saveProfile\(\{\s*weightKg:\s*weight,\s*cupMl:\s*cup,\s*intervalMin:\s*interval,\s*workStart,\s*workEnd,\s*dndRanges:\s*ranges/s,
  );
});

test('numeric profile controls hide native spinner arrows without shrinking inputs', () => {
  assert.match(
    styleCss,
    /input\[type="number"\]::-webkit-inner-spin-button,\s*input\[type="number"\]::-webkit-outer-spin-button\s*\{[^}]*-webkit-appearance:\s*none/s,
  );
  assert.match(styleCss, /input\[type="number"\]\s*\{[^}]*appearance:\s*textfield/s);
  assert.match(styleCss, /input\s*\{[^}]*height:\s*42px/s);
});

test('onboarding contains full and compact two-step structure with no scrolling', () => {
  assert.match(indexHtml, /class="setup-pane setup-profile-pane"[^>]*data-step="1"/);
  assert.match(indexHtml, /class="setup-pane setup-finish-pane"[^>]*data-step="2"/);
  assert.match(indexHtml, /id="setupNext"/);
  assert.match(indexHtml, /id="setupBack"/);
  assert.match(indexJs, /function setSetupStep\(step\)/);
  assert.match(indexJs, /window\.innerHeight < 800/);
  assert.match(indexJs, /classList\.toggle\('compact', compact\)/);
  const setupRule = indexHtml.match(/\.setup-overlay\s*\{([^}]*)\}/s);
  assert.ok(setupRule);
  assert.match(setupRule[1], /overflow:\s*hidden/);
  assert.doesNotMatch(setupRule[1], /overflow-y:\s*auto/);
});

test('progress and drink feedback animate only on meaningful state changes', () => {
  assert.match(indexHtml, /id="progressBar"[^>]*role="progressbar"/);
  assert.match(indexJs, /function renderProgress\(\)/);
  assert.match(indexJs, /progress\.style\.width = `\$\{percentage\}%`/);
  assert.match(indexJs, /progress\.setAttribute\('aria-valuenow', String\(percentage\)\)/);
  assert.match(indexJs, /classList\.add\('count-bump'\)/);
  assert.match(indexHtml, /\.progress-fill\s*\{[^}]*transition:\s*width \.3s/s);
  assert.match(indexHtml, /@keyframes countBump/);
});

test('motion is restrained and reduced-motion disables movement and typewriting', () => {
  assert.match(indexHtml, /\.ui-ready \.content > \*/);
  assert.match(indexHtml, /animation-delay:\s*\.08s/);
  assert.match(indexHtml, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(indexHtml, /animation-duration:\s*\.01ms !important/);
  assert.match(reminderHtml, /@keyframes enter/);
  assert.match(reminderHtml, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(reminderJs, /const reducedMotion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(reminderJs, /if \(reducedMotion\.matches\) \{\s*\$\('#txt'\)\.textContent = text;/s);
});

test('reminder labels move up and snooze uses an accessible three-option menu', () => {
  const metaRule = reminderHtml.match(/\.reminder-meta\s*\{([^}]*)\}/s);
  assert.ok(metaRule, 'reminder metadata rule must exist');
  assert.match(metaRule[1], /top:\s*-10px/);
  assert.match(reminderHtml, /id="btnSnooze"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(reminderHtml, /id="snoozeMenu"[^>]*role="menu"/);
  assert.equal((reminderHtml.match(/class="snooze-option"/g) || []).length, 3);
  for (const minutes of [5, 15, 30]) {
    assert.match(
      reminderHtml,
      new RegExp(`class="snooze-option"[^>]*data-minutes="${minutes}"[^>]*role="menuitem"`),
    );
  }
  assert.match(reminderHtml, />再苟一会\s*<span[^>]*aria-hidden="true">▾<\/span>/);
  assert.doesNotMatch(reminderHtml, />再苟 5 分钟</);

  assert.match(reminderJs, /function openSnoozeMenu\(\)/);
  assert.match(reminderJs, /function closeSnoozeMenu\(/);
  assert.match(reminderJs, /case 'ArrowDown':/);
  assert.match(reminderJs, /case 'ArrowUp':/);
  assert.match(reminderJs, /event\.key === 'Escape'/);
  assert.match(reminderJs, /act\('snooze',\s*minutes\)/);
});

test('selected snooze minutes cross the preload boundary and are validated before scheduling', () => {
  assert.match(
    preloadJs,
    /reminderAction:\s*\(action,\s*snoozeMinutes\)\s*=>\s*ipcRenderer\.invoke\('reminder-action',\s*action,\s*snoozeMinutes\)/,
  );
  assert.match(mainJs, /const \{\s*decideTick,\s*normalizeSnoozeMinutes\s*\} = require\('\.\/lib\/scheduler\.js'\)/s);
  assert.match(mainJs, /ipcMain\.handle\('reminder-action',\s*\(event,\s*action,\s*snoozeMinutes\)\s*=>/);
  assert.match(
    mainJs,
    /const validatedSnoozeMinutes = normalizeSnoozeMinutes\(snoozeMinutes\);[\s\S]*?if \(validatedSnoozeMinutes === null\)[\s\S]*?reminderActive = false;[\s\S]*?scheduleNext\(validatedSnoozeMinutes \* 60_000\)/,
  );
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

test('renderer boundaries explicitly enable Electron isolation and validate navigation and IPC senders', () => {
  assert.equal((mainJs.match(/contextIsolation:\s*true/g) || []).length, 2);
  assert.equal((mainJs.match(/nodeIntegration:\s*false/g) || []).length, 2);
  assert.equal((mainJs.match(/sandbox:\s*true/g) || []).length, 2);
  assert.match(mainJs, /function lockWindowNavigation\(win, allowedUrl\)/);
  assert.match(mainJs, /win\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainJs, /win\.webContents\.on\('will-navigate'/);
  assert.match(mainJs, /event\.senderFrame\?\.url === expectedUrl/);
  assert.match(
    mainJs,
    /ipcMain\.handle\('get-state', \(event\) => \(\s*fromWindow\(event, mainWin\)\s*\|\|\s*fromWindow\(event, remWin\)/s,
  );
  assert.match(
    preloadJs,
    /onReminderCancel:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('reminder-cancel',\s*\(\)\s*=>\s*cb\(\)\)/,
  );
  assert.match(mainJs, /const invalidWindowRequest = \(\) => \(\{ ok: false, error: '无效窗口请求' \}\)/);
  assert.doesNotMatch(mainJs, /fromWindow\(event, mainWin\) \? doDrink\('main'\) : snapshot\(\)/);
  assert.doesNotMatch(mainJs, /if \(!fromWindow\(event, remWin\)\) return snapshot\(\)/);
  assert.doesNotMatch(mainJs, /fromWindow\(event, mainWin\) \? setSetting\(key, value\) : snapshot\(\)/);
});

test('DND editor assigns persisted values through DOM properties instead of HTML markup', () => {
  const editor = indexJs.match(/function renderDndEditor\(container, ranges, onChange\) \{[\s\S]*?\n\}/);
  assert.ok(editor, 'DND editor must exist');
  assert.doesNotMatch(editor[0], /row\.innerHTML/);
  assert.match(editor[0], /startInput\.value = range\.start/);
  assert.match(editor[0], /endInput\.value = range\.end/);
  assert.match(editor[0], /removeButton\.textContent = '×'/);
});

test('setting switches are keyboard-accessible and expose their pressed state', () => {
  for (const id of ['swSedentary', 'swWeekend', 'swSound', 'swAuto']) {
    assert.match(indexHtml, new RegExp(`<button[^>]+id="${id}"[^>]+type="button"[^>]+aria-label="[^"]+"`));
  }
  assert.match(indexJs, /control\.setAttribute\('aria-pressed', String\(!!enabled\)\)/);
  assert.match(styleCss, /\.switch:focus-visible/);
});

test('renderer preserves drafts and storage errors across periodic state updates', () => {
  assert.equal((indexJs.match(/settingsDraftReady = false/g) || []).length, 1);
  assert.equal((indexJs.match(/setupDraftReady = false/g) || []).length, 1);
  assert.match(
    indexJs,
    /function updateSetupPreview\(\)\s*\{\s*if \(S && S\.storageError\) \{\s*\$\('#setupError'\)\.textContent = S\.storageError;\s*return;\s*\}/s,
  );
  assert.match(
    indexJs,
    /function updateSettingsPreview\(\)\s*\{\s*if \(S && S\.storageError\) \{\s*\$\('#settingsError'\)\.textContent = S\.storageError;\s*return;\s*\}\s*if \(!S\) return;/s,
  );
});

test('successful onboarding synchronizes the hidden main settings draft', () => {
  assert.match(indexJs, /function populateSettingsDraft\(profile\)/);
  assert.match(indexJs, /if \(!settingsDraftReady\) \{\s*populateSettingsDraft\(state\);/s);
  assert.match(
    indexJs,
    /if \(setup\) \{\s*populateSettingsDraft\(\{\s*weightKg:\s*weight,\s*cupMl:\s*cup,\s*intervalMin:\s*interval,\s*workStart,\s*workEnd,\s*dndRanges:\s*ranges,?\s*\}\);/s,
  );
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

test('removed automatic interval presentation has no library or stylesheet remnants', () => {
  assert.equal(hydrationJs.includes(legacyTerms.supportedIntervals), false);
  assert.equal(hydrationJs.includes(legacyTerms.legacyRecommendation), false);
  assert.doesNotMatch(styleCss, /\.seg\b/);
});

test('periodic state rendering never overwrites a focused setting control', () => {
  assert.match(indexJs, /function syncControlValue\(control, value\)/);
  assert.match(indexJs, /document\.activeElement !== control/);
  assert.match(indexJs, /\$\('#selStart'\)\.value = profile\.workStart \|\| '09:00'/);
  assert.match(indexJs, /\$\('#selEnd'\)\.value = profile\.workEnd \|\| '18:00'/);
  assert.doesNotMatch(indexJs, /syncControlValue\(\$\('#selStart'\),\s*S\.workStart\)/);
  assert.doesNotMatch(indexJs, /syncControlValue\(\$\('#selEnd'\),\s*S\.workEnd\)/);
  assert.match(indexJs, /syncControlValue\(\$\('#intervalInput'\),\s*S\.intervalMin\)/);
});

test('interval draft survives stale renders between change and Save', () => {
  assert.match(indexJs, /let intervalDraftDirty = false;/);
  assert.match(
    indexJs,
    /\$\('#intervalInput'\)\.addEventListener\('input', \(\) => \{\s*intervalDraftDirty = true;\s*updateSettingsPreview\(\);\s*\}\);/s,
  );
  assert.match(indexJs, /if \(!intervalDraftDirty\) syncControlValue\(\$\('#intervalInput'\),\s*S\.intervalMin\);/);
  assert.match(
    indexJs,
    /async function saveManualInterval\(\) \{\s*const control = \$\('#intervalInput'\);\s*const submittedValue = control\.value;\s*const interval = Number\(submittedValue\);/s,
  );
  assert.match(indexJs, /if \(control\.value === submittedValue\) intervalDraftDirty = false;/);
  assert.match(
    indexJs,
    /if \(setup\) \{[\s\S]*?\} else \{\s*if \(\$\('#intervalInput'\)\.value === String\(interval\)\) intervalDraftDirty = false;/,
  );
});

test('main process uses only validated manual reminder intervals', () => {
  assert.equal(mainJs.includes(legacyTerms.intervalOptions), false);
  assert.equal(mainJs.includes(legacyTerms.legacyRefresh), false);
  assert.match(mainJs, /validateIntervalMin\(value\)/);
  assert.match(mainJs, /db\.settings\.intervalMin = validation\.profile\.intervalMin/);
});

test('main process keeps version-specific backups while upgrading to schema v3', () => {
  assert.match(mainJs, /function backupFile\(version\)/);
  assert.match(mainJs, /`gokugoku-data\.v\$\{version\}\.bak\.json`/);
  assert.match(mainJs, /result\.migratedFromVersion/);
  assert.match(mainJs, /backupFile\(result\.migratedFromVersion\)/);
  assert.doesNotMatch(mainJs, /migratedFromV1/);
  assert.match(mainJs, /if \(migratedFromVersion && !persistenceError\) writeDatabaseAtomic\(\)/);
});

test('saveProfile persists minute-precise work hours with the rest of the profile', () => {
  assert.match(mainJs, /db\.settings\.workStart = validation\.profile\.workStart/);
  assert.match(mainJs, /db\.settings\.workEnd = validation\.profile\.workEnd/);
  assert.match(mainJs, /db\.settings\.dndRanges = validation\.profile\.dndRanges/);
  assert.match(mainJs, /validateWorkHours\(candidateStart, candidateEnd\)/);
  assert.doesNotMatch(mainJs, /db\.settings\.workStart = Number\(value\)/);
  assert.doesNotMatch(mainJs, /db\.settings\.workEnd = Number\(value\)/);
});

test('main window uses the compact collapsed height', () => {
  assert.match(mainJs, /width:\s*480/);
  assert.match(mainJs, /workArea\.height >= 904 \? 880/);
  assert.match(mainJs, /profileCompleted \? 720/);
  assert.match(mainJs, /resizeMainWindow\(720\)/);
  assert.match(mainJs, /const target = open \? Math\.min\(960, workArea\.height - 24\) : 720/);
  assert.match(mainJs, /width:\s*520/);
  assert.match(mainJs, /height:\s*380/);
});

test('Electron shot mode checks both onboarding layouts for real overflow', () => {
  for (const filename of [
    'shot-onboarding-880.png',
    'shot-onboarding-720-step1.png',
    'shot-onboarding-720-step2.png',
    'shot-reminder-snooze-menu.png',
  ]) {
    assert.ok(shotModeJs.includes(filename), `missing screenshot ${filename}`);
    assert.equal(mainJs.includes(filename), false, `production main.js still contains ${filename}`);
  }
  assert.match(shotModeJs, /overlay\.scrollHeight <= overlay\.clientHeight/);
  assert.match(shotModeJs, /card\.scrollHeight <= card\.clientHeight/);
  assert.match(shotModeJs, /首次设置页面溢出/);
  assert.match(shotModeJs, /function setShotWindowSize\(width, height\)/);
  assert.match(shotModeJs, /screen\.getPrimaryDisplay\(\)/);
  assert.match(shotModeJs, /Math\.round\(workArea\.x \+ \(workArea\.width - width\) \/ 2\)/);
  assert.match(shotModeJs, /mainWin\.getSize\(\)/);
  assert.match(shotModeJs, /截图窗口尺寸错误/);
  assert.match(shotModeJs, /document\.getElementById\('btnSnooze'\)\.click\(\)/);
  assert.match(shotModeJs, /document\.getElementById\('snoozeMenu'\)\.getBoundingClientRect\(\)/);
  assert.match(shotModeJs, /延后菜单超出提醒窗口/);
  assert.match(mainJs, /app\.commandLine\.appendSwitch\('force-device-scale-factor', '1'\)/);
  assert.match(mainJs, /if \(process\.env\.SHOT\) \{\r?\n\s+const \{ createShotMode \} = require\('\.\/scripts\/shot-mode\.js'\);/);
  assert.match(mainJs, /shotMode\(\)\.catch\(\(error\) =>/);
  assert.match(mainJs, /app\.exit\(1\)/);
  assert.doesNotMatch(mainJs, /function setShotWindowSize/);
  assert.doesNotMatch(mainJs, /async function shotMode/);
});

test('daily reset is exposed only through the main settings interface', () => {
  assert.match(indexHtml, /id="resetTodayBtn"/);
  assert.match(indexHtml, />重置今日记录</);
  assert.match(indexJs, /window\.confirm\(/);
  assert.match(indexJs, /window\.api\.resetToday\(\)/);
  assert.match(preloadJs, /resetToday:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('reset-today'\)/);
  assert.match(mainJs, /ipcMain\.handle\('reset-today'/);
  assert.match(mainJs, /fromWindow\(event,\s*mainWin\)/);
});

test('release metadata and license meet the Windows packaging contract', () => {
  const licensePath = path.join(root, 'LICENSE');
  assert.equal(fs.existsSync(licensePath), true, 'source LICENSE must exist');
  const license = fs.readFileSync(licensePath, 'utf8');
  assert.match(license, /Copyright \(c\) 2026 水分補給課/);
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/);

  const packWin = packageJson.scripts['pack:win'];
  assert.equal(packWin, 'node scripts/pack-win.js');
  assert.equal(packageJson.engines.node, '>=22.12');
});
