// 水分補給課 · 主进程：窗口、托盘、催水调度、数据持久化
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const COPY = require('./ui/copy.js');
const { ensureMigrationBackup } = require('./lib/migration-backup.js');
const {
  calculateTargets,
  getReminderAvailability,
  validateIntervalMin,
  validateProfileInput,
  validateWorkHours,
} = require('./lib/hydration.js');
const {
  DEFAULT_SETTINGS,
  createDefaultDatabase,
  migrateDatabase,
  recordDrink,
  resetToday,
  rolloverDay,
  undoDrink,
} = require('./lib/data.js');
const { decideTick, normalizeSnoozeMinutes } = require('./lib/scheduler.js');

const MAIN_PAGE_URL = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const REMINDER_PAGE_URL = pathToFileURL(path.join(__dirname, 'ui', 'reminder.html')).href;
const IS_HIDDEN_LAUNCH = process.argv.includes('--hidden');
if (process.env.SHOT) app.commandLine.appendSwitch('force-device-scale-factor', '1');
if (process.env.SHOT_DATA_DIR) app.setPath('userData', path.resolve(process.env.SHOT_DATA_DIR));

let mainWin = null;
let remWin = null;
let tray = null;
let tickTimer = null;
let saveTimer = null;
let balloonShown = false;
let nextAt = null;
let pausedUntil = null;
let lastUndo = null;
let reminderActive = false;
let lastReminderIdx = -1;
let persistenceError = null;
let lastTickAt = null;
let quitting = false;
let trayTip = null;
let db = createDefaultDatabase(todayStr());

/* ---------- 数据 ---------- */
function dataFile() {
  return path.join(app.getPath('userData'), 'gokugoku-data.json');
}

function backupFile(version) {
  return path.join(app.getPath('userData'), `gokugoku-data.v${version}.bak.json`);
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load() {
  persistenceError = null;
  let migratedFromVersion = null;
  if (!fs.existsSync(dataFile())) {
    db = createDefaultDatabase(todayStr());
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    const result = migrateDatabase(raw, todayStr());
    db = result.db;
    migratedFromVersion = result.migratedFromVersion;
    if (result.migratedFromVersion) {
      const migrationBackup = backupFile(result.migratedFromVersion);
      try {
        ensureMigrationBackup(dataFile(), migrationBackup);
      } catch {
        persistenceError = '旧版数据备份失败。请检查数据目录权限后重新启动，本课不会覆盖原文件。';
      }
    }
  } catch (error) {
    db = createDefaultDatabase(todayStr());
    persistenceError = `现有数据无法安全读取（${error.message}）。本课已进入只读保护，不会覆盖原文件。`;
  }

  if (todayStr() !== db.date) rolloverDay(db, todayStr());
  if (!validProfile(db.settings)) db.profileCompleted = false;
  if (migratedFromVersion && !persistenceError) writeDatabaseAtomic();
}

function save() {
  if (persistenceError) return false;
  clearTimeout(saveTimer);
  saveTimer = null;
  return writeDatabaseAtomic();
}

function writeDatabaseAtomic() {
  if (persistenceError) return false;
  const target = dataFile();
  const temporary = `${target}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(db, null, 2));
    fs.renameSync(temporary, target);
    return true;
  } catch (error) {
    persistenceError = `数据保存失败（${error.message}）。本课已停止写入，请检查磁盘和目录权限。`;
    return false;
  }
}

function validProfile(settings) {
  return validateProfileInput(settings).ok;
}

function derived() {
  return calculateTargets({
    weightKg: Number(db.settings.weightKg) || 60,
    cupMl: Number(db.settings.cupMl) || 200,
    workStart: db.settings.workStart,
    workEnd: db.settings.workEnd,
    consumedMl: db.consumedMl,
    drinkCount: db.drinkCount,
  });
}

/* ---------- 状态 ---------- */
function activeUndo(now = Date.now()) {
  return lastUndo && now <= lastUndo.expiresAt ? lastUndo : null;
}

function goalDone() {
  return db.consumedMl >= derived().workGoalMl;
}

function snapshot() {
  const now = new Date();
  const availability = getReminderAvailability(now, db.settings);
  const metrics = derived();
  const undo = activeUndo(now.getTime());
  const paused = Number(pausedUntil) > now.getTime();

  return {
    now: now.getTime(),
    profileRequired: !db.profileCompleted,
    cups: db.drinkCount,
    goal: metrics.targetCups,
    drinkCount: db.drinkCount,
    targetCups: metrics.targetCups,
    consumedMl: db.consumedMl,
    dailyGoalMl: metrics.dailyGoalMl,
    workGoalMl: metrics.workGoalMl,
    weightKg: db.settings.weightKg,
    cupMl: db.settings.cupMl,
    dndRanges: db.settings.dndRanges.map((range) => ({ ...range })),
    sedentaryEnabled: db.settings.sedentaryEnabled,
    intervalMin: db.settings.intervalMin,
    workStart: db.settings.workStart,
    workEnd: db.settings.workEnd,
    weekend: db.settings.weekend,
    sound: db.settings.sound,
    autoLaunch: db.settings.autoLaunch,
    working: availability.allowed,
    offReason: availability.allowed ? null : availability.reason,
    resumeAt: availability.resumeAt ? availability.resumeAt.getTime() : null,
    paused,
    pausedUntil,
    nextAt,
    goalDone: goalDone(),
    overdue: availability.allowed && !!nextAt && now.getTime() >= nextAt && !goalDone(),
    reminderActive,
    undoAvailable: !!undo,
    undoId: undo ? undo.id : null,
    undoUntil: undo ? undo.expiresAt : null,
    storageError: persistenceError,
  };
}

function pushState({ rebuildMenu = false } = {}) {
  const state = snapshot();
  for (const win of [mainWin, remWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
  }
  updateTray(state);
  if (rebuildMenu) rebuildTrayMenu();
  return state;
}

/* ---------- 调度 ---------- */
function effectiveIntervalMs(minutes = db.settings.intervalMin) {
  return Number(minutes) * 60_000;
}

function scheduleNext(delayMs = effectiveIntervalMs()) {
  nextAt = Date.now() + delayMs;
}

function minutesSinceDrink() {
  if (!db.lastDrinkAt) return db.settings.intervalMin;
  return Math.max(1, Math.round((Date.now() - db.lastDrinkAt) / 60_000));
}

function isReminderVisible() {
  return remWin && !remWin.isDestroyed() && remWin.isVisible();
}

function cancelVisibleReminder() {
  reminderActive = false;
  if (remWin && !remWin.isDestroyed()) {
    remWin.webContents.send('reminder-cancel');
    remWin.hide();
  }
}

function tick() {
  const now = new Date();
  const nowMs = now.getTime();
  let previousTickAt = lastTickAt;
  let menuChanged = false;

  if (todayStr(now) !== db.date) {
    if (isReminderVisible()) cancelVisibleReminder();
    rolloverDay(db, todayStr(now));
    lastUndo = null;
    nextAt = null;
    previousTickAt = null;
    save();
    menuChanged = true;
  }

  if (pausedUntil && now.getTime() >= pausedUntil) {
    pausedUntil = null;
    nextAt = null;
    menuChanged = true;
  }
  if (lastUndo && now.getTime() > lastUndo.expiresAt) {
    lastUndo = null;
    menuChanged = true;
  }

  const availability = getReminderAvailability(now, db.settings);
  const decision = decideTick({
    now,
    lastTickAt: previousTickAt,
    nextAt,
    reminderVisible: reminderActive,
    goalDone: goalDone(),
    profileCompleted: db.profileCompleted && !persistenceError,
    pausedUntil,
    intervalMin: db.settings.intervalMin,
    settings: db.settings,
  });

  nextAt = decision.nextAt;
  if (decision.hideReminder || (!availability.allowed && isReminderVisible())) {
    cancelVisibleReminder();
  }
  if (decision.fireReminder) fireReminder();
  lastTickAt = nowMs;
  pushState({ rebuildMenu: menuChanged });
}

/* ---------- 催水弹窗 ---------- */
function pickReminder() {
  let index;
  do {
    index = Math.floor(Math.random() * COPY.reminders.length);
  } while (index === lastReminderIdx);
  lastReminderIdx = index;
  return COPY.reminders[index];
}

function fireReminder(forcedText) {
  if (!remWin || remWin.isDestroyed() || !db.profileCompleted || persistenceError) return;
  const availability = getReminderAvailability(new Date(), db.settings);
  if (!availability.allowed || goalDone() || Number(pausedUntil) > Date.now()) return;

  const text = (forcedText || pickReminder()).replace('{mins}', String(minutesSinceDrink()));
  reminderActive = true;
  nextAt = null;
  positionReminder();
  remWin.webContents.send('reminder', {
    text,
    sound: db.settings.sound,
    cupMl: db.settings.cupMl,
    sedentaryEnabled: db.settings.sedentaryEnabled,
  });
  remWin.showInactive();
}

function positionReminder() {
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = remWin.getSize();
  remWin.setPosition(
    workArea.x + workArea.width - width - 12,
    workArea.y + workArea.height - height - 12,
  );
}

/* ---------- 窗口 ---------- */
function mainWindowHeight(workArea, profileCompleted) {
  return profileCompleted ? 720 : (
    workArea.height >= 904 ? 880 : Math.max(640, Math.min(720, workArea.height))
  );
}

function resizeMainWindow(targetHeight) {
  if (!mainWin || mainWin.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(mainWin.getBounds());
  const height = Math.min(targetHeight, workArea.height);
  const [x, y] = mainWin.getPosition();
  mainWin.setBounds({
    x,
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width: 480,
    height,
  }, true);
}

function lockWindowNavigation(win, allowedUrl) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedUrl) event.preventDefault();
  });
}

function createWindows() {
  const { workArea } = screen.getPrimaryDisplay();
  mainWin = new BrowserWindow({
    width: 480,
    height: mainWindowHeight(workArea, db.profileCompleted),
    minWidth: 480,
    minHeight: 640,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    icon: path.join(__dirname, 'assets', 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockWindowNavigation(mainWin, MAIN_PAGE_URL);
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if ((!IS_HIDDEN_LAUNCH || !db.profileCompleted) && !process.env.SHOT) mainWin.show();
  });
  mainWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideToTray();
    }
  });

  remWin = new BrowserWindow({
    width: 520,
    height: 380,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockWindowNavigation(remWin, REMINDER_PAGE_URL);
  remWin.loadFile(path.join(__dirname, 'ui', 'reminder.html'));
  remWin.setAlwaysOnTop(true, 'screen-saver');
  remWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function hideToTray() {
  mainWin.hide();
  if (!balloonShown && process.platform === 'win32') {
    balloonShown = true;
    try {
      tray.displayBalloon({
        title: '水分補給課仍在执勤',
        content: '本课已缩进托盘继续潜伏。到点照样催你，请安心工作。',
        icon: path.join(__dirname, 'assets', 'app.png'),
      });
    } catch { /* 部分系统不支持 balloon */ }
  }
}

function showMain() {
  if (!mainWin) return;
  mainWin.show();
  mainWin.focus();
}

/* ---------- 托盘 ---------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.on('click', showMain);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const pausedNow = Number(pausedUntil) > Date.now();
  const undo = activeUndo();
  const template = [
    { label: db.profileCompleted ? '打开课室' : '完成首次设置', click: showMain },
    {
      label: `咕嘟一杯（+${db.settings.cupMl}ml）`,
      enabled: db.profileCompleted && !persistenceError,
      click: () => doDrink('tray'),
    },
  ];

  if (undo) {
    template.push({
      label: `撤销刚才一杯（-${undo.amountMl}ml）`,
      click: () => undoLatest(undo.id, 'tray'),
    });
  }

  template.push(
    pausedNow
      ? {
        label: '恢复催水',
        click: () => {
          pausedUntil = null;
          nextAt = null;
          pushState({ rebuildMenu: true });
        },
      }
      : {
        label: '让本课安静 1 小时',
        click: () => {
          pausedUntil = Date.now() + 3_600_000;
          nextAt = null;
          cancelVisibleReminder();
          pushState({ rebuildMenu: true });
        },
      },
    { type: 'separator' },
    {
      label: '退出（本课解散）',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function updateTray(state) {
  if (!tray) return;
  const text = persistenceError
    ? '水分補給課｜数据写入已暂停，请打开主界面查看'
    : db.profileCompleted
    ? `水分補給課｜今日 ${state.drinkCount}/${state.targetCups} 杯 · ${state.consumedMl}/${state.workGoalMl}ml${state.paused ? '（静音中）' : ''}`
    : '水分補給課｜等待完成首次设置';
  if (trayTip !== text) {
    trayTip = text;
    tray.setToolTip(text);
  }
}

/* ---------- 动作 ---------- */
function doDrink(source = 'main') {
  if (persistenceError) return { ok: false, error: persistenceError, ...snapshot() };
  if (!db.profileCompleted) return { ok: false, error: '请先完成首次设置', ...snapshot() };
  const shouldCancelReminder = source !== 'reminder' && isReminderVisible();
  const id = crypto.randomUUID();
  const undo = recordDrink(db, Date.now(), id);
  if (!save()) {
    undoDrink(db, undo, id, Date.now());
    lastUndo = null;
    const failedState = pushState({ rebuildMenu: true });
    return { ok: false, error: persistenceError, ...failedState };
  }

  lastUndo = undo;
  if (shouldCancelReminder) cancelVisibleReminder();
  else reminderActive = false;
  if (!goalDone()) scheduleNext();
  else nextAt = null;
  const state = pushState({ rebuildMenu: true });
  return { ok: true, ...state, source, undoId: id, undoUntil: lastUndo.expiresAt };
}

function undoLatest(id, source = 'main') {
  if (persistenceError) {
    return { ok: false, reason: 'storage', error: persistenceError, state: snapshot() };
  }
  const before = {
    drinkCount: db.drinkCount,
    consumedMl: db.consumedMl,
    lastDrinkAt: db.lastDrinkAt,
  };
  const result = undoDrink(db, lastUndo, id, Date.now());
  if (result.ok) {
    if (!save()) {
      db.drinkCount = before.drinkCount;
      db.consumedMl = before.consumedMl;
      db.lastDrinkAt = before.lastDrinkAt;
      const failedState = pushState({ rebuildMenu: true });
      return { ok: false, reason: 'storage', error: persistenceError, state: failedState };
    }
    lastUndo = null;
    reminderActive = false;
    if (source !== 'reminder' && isReminderVisible()) cancelVisibleReminder();
    if (!goalDone()) scheduleNext();
  }
  const state = pushState({ rebuildMenu: true });
  return { ...result, state };
}

function resetTodayProgress() {
  if (persistenceError) return { ok: false, error: persistenceError, state: snapshot() };
  const previous = {
    date: db.date,
    drinkCount: db.drinkCount,
    consumedMl: db.consumedMl,
    lastDrinkAt: db.lastDrinkAt,
    history: Object.fromEntries(
      Object.entries(db.history).map(([date, value]) => [date, { ...value }]),
    ),
  };
  resetToday(db, todayStr());
  const previousUndo = lastUndo;
  const previousNextAt = nextAt;
  lastUndo = null;
  nextAt = null;

  if (!save()) {
    Object.assign(db, previous);
    lastUndo = previousUndo;
    nextAt = previousNextAt;
    return { ok: false, error: persistenceError, state: pushState({ rebuildMenu: true }) };
  }

  if (isReminderVisible()) cancelVisibleReminder();
  reminderActive = false;
  const availability = getReminderAvailability(new Date(), db.settings);
  if (availability.allowed) scheduleNext();
  return { ok: true, state: pushState({ rebuildMenu: true }) };
}

function saveProfile(input) {
  if (persistenceError) return { ok: false, error: persistenceError };
  const validation = validateProfileInput(input);
  if (!validation.ok) return validation;
  const previousSettings = {
    ...db.settings,
    dndRanges: db.settings.dndRanges.map((range) => ({ ...range })),
  };
  const previousProfileCompleted = db.profileCompleted;
  const previousNextAt = nextAt;
  db.settings.weightKg = validation.profile.weightKg;
  db.settings.cupMl = validation.profile.cupMl;
  db.settings.intervalMin = validation.profile.intervalMin;
  db.settings.intervalMode = 'manual';
  db.settings.workStart = validation.profile.workStart;
  db.settings.workEnd = validation.profile.workEnd;
  db.settings.dndRanges = validation.profile.dndRanges;
  db.profileCompleted = true;
  nextAt = null;
  if (!save()) {
    db.settings = previousSettings;
    db.profileCompleted = previousProfileCompleted;
    nextAt = previousNextAt;
    pushState({ rebuildMenu: true });
    return { ok: false, error: persistenceError };
  }
  if (isReminderVisible()) cancelVisibleReminder();
  resizeMainWindow(720);
  return { ok: true, state: pushState({ rebuildMenu: true }) };
}

function setSetting(key, value) {
  if (persistenceError) return { ok: false, error: persistenceError, ...snapshot() };
  const previousSettings = {
    ...db.settings,
    dndRanges: db.settings.dndRanges.map((range) => ({ ...range })),
  };
  const previousNextAt = nextAt;
  const booleanKeys = new Set(['weekend', 'sound', 'autoLaunch', 'sedentaryEnabled']);
  if (booleanKeys.has(key)) {
    if (typeof value !== 'boolean') return snapshot();
    db.settings[key] = !!value;
  } else if (key === 'intervalMin') {
    const validation = validateIntervalMin(value);
    if (!validation.ok) return { ok: false, error: validation.error, ...snapshot() };
    db.settings.intervalMin = validation.intervalMin;
    db.settings.intervalMode = 'manual';
  } else if (key === 'workStart' || key === 'workEnd') {
    const candidateStart = key === 'workStart' ? value : db.settings.workStart;
    const candidateEnd = key === 'workEnd' ? value : db.settings.workEnd;
    const validation = validateWorkHours(candidateStart, candidateEnd);
    if (!validation.ok) return { ok: false, error: validation.error, ...snapshot() };
    db.settings.workStart = validation.workStart;
    db.settings.workEnd = validation.workEnd;
  } else {
    return snapshot();
  }

  if (['workStart', 'workEnd', 'weekend', 'intervalMin'].includes(key)) {
    nextAt = null;
  }
  if (!save()) {
    db.settings = previousSettings;
    nextAt = previousNextAt;
    return { ok: false, error: persistenceError, ...pushState({ rebuildMenu: true }) };
  }
  if (key === 'autoLaunch') {
    try {
      app.setLoginItemSettings({ openAtLogin: !!value, args: ['--hidden'] });
    } catch { /* 开发环境可能不支持 */ }
  }
  return { ok: true, ...pushState({ rebuildMenu: key === 'weekend' }) };
}

/* ---------- IPC ---------- */
function setupIpc() {
  const fromWindow = (event, win) => {
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return false;
    const expectedUrl = win === mainWin ? MAIN_PAGE_URL : REMINDER_PAGE_URL;
    return event.senderFrame === win.webContents.mainFrame
      && event.senderFrame?.url === expectedUrl;
  };
  const invalidWindowRequest = () => ({ ok: false, error: '无效窗口请求' });
  ipcMain.handle('get-state', (event) => (
    fromWindow(event, mainWin) || fromWindow(event, remWin)
      ? snapshot()
      : invalidWindowRequest()
  ));
  ipcMain.handle('drink', (event) => (
    fromWindow(event, mainWin) ? doDrink('main') : invalidWindowRequest()
  ));
  ipcMain.handle('undo-drink', (event, id) => {
    if (fromWindow(event, remWin)) return undoLatest(id, 'reminder');
    if (fromWindow(event, mainWin)) return undoLatest(id, 'main');
    return { ...invalidWindowRequest(), reason: 'invalid-sender' };
  });
  ipcMain.handle('reset-today', (event) => (
    fromWindow(event, mainWin)
      ? resetTodayProgress()
      : invalidWindowRequest()
  ));
  ipcMain.handle('save-profile', (event, profile) => (
    fromWindow(event, mainWin) ? saveProfile(profile) : invalidWindowRequest()
  ));
  ipcMain.handle('set-setting', (event, key, value) => (
    fromWindow(event, mainWin) ? setSetting(key, value) : invalidWindowRequest()
  ));
  ipcMain.handle('reminder-action', (event, action, snoozeMinutes) => {
    if (!fromWindow(event, remWin)) return invalidWindowRequest();
    if (!['drink', 'snooze', 'dismiss'].includes(action)) {
      return { ok: false, error: '无效提醒操作' };
    }
    if (action === 'snooze') {
      const validatedSnoozeMinutes = normalizeSnoozeMinutes(snoozeMinutes);
      if (validatedSnoozeMinutes === null) {
        return { ok: false, error: '无效稍后提醒时长' };
      }
      reminderActive = false;
      scheduleNext(validatedSnoozeMinutes * 60_000);
      return pushState();
    }
    reminderActive = false;
    if (action === 'drink') return doDrink('reminder');
    if (action === 'dismiss') scheduleNext();
    const state = pushState();
    return state;
  });
  ipcMain.handle('reminder-done', (event) => {
    if (!fromWindow(event, remWin)) return;
    reminderActive = false;
    if (remWin && !remWin.isDestroyed()) remWin.hide();
  });
  ipcMain.handle('win-min', (event) => {
    if (fromWindow(event, mainWin)) mainWin.minimize();
  });
  ipcMain.handle('win-hide', (event) => {
    if (fromWindow(event, mainWin)) hideToTray();
  });
  ipcMain.handle('set-expand', (event, open) => {
    if (!fromWindow(event, mainWin)) return;
    const { workArea } = screen.getDisplayMatching(mainWin.getBounds());
    const target = open ? Math.min(960, workArea.height - 24) : 720;
    const [x, y] = mainWin.getPosition();
    mainWin.setBounds({
      x,
      y: Math.max(workArea.y + 12, Math.min(y, workArea.y + workArea.height - target - 12)),
      width: 480,
      height: target,
    }, true);
  });
}

/* ---------- 截图模式 ---------- */
async function advanceShotTicks() {
  for (let count = 0; count < 2; count += 1) {
    tick();
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
}

async function assertSetupFits(label) {
  const metrics = await mainWin.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('onboarding');
    const card = overlay.querySelector('.setup-card');
    return {
      overlayFits: overlay.scrollHeight <= overlay.clientHeight,
      cardFits: card.scrollHeight <= card.clientHeight,
      overlayClient: overlay.clientHeight,
      overlayScroll: overlay.scrollHeight,
      cardClient: card.clientHeight,
      cardScroll: card.scrollHeight,
    };
  })()`);
  if (!metrics.overlayFits || !metrics.cardFits) {
    throw new Error(`首次设置页面溢出（${label}）：${JSON.stringify(metrics)}`);
  }
}

function setShotWindowSize(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  mainWin.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  }, false);
  const [actualWidth, actualHeight] = mainWin.getSize();
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`截图窗口尺寸错误：期望 ${width}x${height}，实际 ${actualWidth}x${actualHeight}`);
  }
}

async function shotMode() {
  clearInterval(tickTimer);
  tickTimer = null;
  if (mainWin.webContents.isLoading()) {
    await new Promise((resolve) => mainWin.webContents.once('did-finish-load', resolve));
  }
  const out = process.env.SHOT_DIR || __dirname;
  db.profileCompleted = false;
  setShotWindowSize(480, 880);
  pushState();
  mainWin.show();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await assertSetupFits('480x880 单页');
  const onboarding880 = (await mainWin.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(out, 'shot-onboarding-880.png'), onboarding880);
  fs.writeFileSync(path.join(out, 'shot-onboarding.png'), onboarding880);

  setShotWindowSize(480, 720);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await mainWin.webContents.executeJavaScript('setSetupStep(1); void 0;');
  await assertSetupFits('480x720 第一步');
  fs.writeFileSync(
    path.join(out, 'shot-onboarding-720-step1.png'),
    (await mainWin.webContents.capturePage()).toPNG(),
  );
  await mainWin.webContents.executeJavaScript("document.getElementById('setupNext').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assertSetupFits('480x720 第二步');
  fs.writeFileSync(
    path.join(out, 'shot-onboarding-720-step2.png'),
    (await mainWin.webContents.capturePage()).toPNG(),
  );
  await mainWin.webContents.executeJavaScript(`
    document.getElementById('setupWeight').value = '60';
    document.getElementById('setupCup').value = '200';
    const setupInterval = document.getElementById('setupInterval');
    if (setupInterval) setupInterval.value = '45';
    document.getElementById('setupSubmit').click();
    void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (!db.profileCompleted) throw new Error('首次设置保存验证失败');

  const startDraft = await mainWin.webContents.executeJavaScript(`
    (() => {
      const control = document.getElementById('selStart');
      control.focus();
      const draft = control.value === '10:30' ? '11:15' : '10:30';
      control.value = draft;
      return draft;
    })()
  `);
  await advanceShotTicks();
  const focusedStart = await mainWin.webContents.executeJavaScript(`
    (() => {
      const control = document.getElementById('selStart');
      return { focused: document.activeElement === control, value: control.value };
    })()
  `);
  if (!focusedStart.focused || focusedStart.value !== startDraft) {
    throw new Error('聚焦的上班开始时间被状态刷新覆盖');
  }
  await mainWin.webContents.executeJavaScript(`
    (() => {
      const control = document.getElementById('selStart');
      control.value = ${JSON.stringify(db.settings.workStart)};
      control.blur();
    })()
  `);

  const intervalDraft = await mainWin.webContents.executeJavaScript(`
    (() => {
      const control = document.getElementById('intervalInput');
      const draft = control.value === '47' ? '48' : '47';
      control.value = draft;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.blur();
      return draft;
    })()
  `);
  await advanceShotTicks();
  const retainedInterval = await mainWin.webContents.executeJavaScript("document.getElementById('intervalInput').value");
  if (retainedInterval !== intervalDraft) {
    throw new Error('未保存的催水间隔草稿被状态刷新覆盖');
  }
  await mainWin.webContents.executeJavaScript(`
    document.getElementById('intervalInput').dispatchEvent(new Event('change', { bubbles: true }));
    void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (db.settings.intervalMin !== Number(intervalDraft)) {
    throw new Error('催水间隔变更未持久化');
  }

  db.settings.weightKg = 60;
  db.settings.cupMl = 200;
  db.profileCompleted = true;
  db.drinkCount = 7;
  db.consumedMl = 1400;
  pushState();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const displayedProgress = await mainWin.webContents.executeJavaScript(`
    document.getElementById('cupNum').textContent + '/' + document.getElementById('goalNum').textContent;
  `);
  if (displayedProgress !== '7/5') throw new Error(`超额目标杯数显示错误：${displayedProgress}`);
  fs.writeFileSync(path.join(out, 'shot-main.png'), (await mainWin.webContents.capturePage()).toPNG());
  await mainWin.webContents.executeJavaScript(`
    document.getElementById('cupInput').value = '250';
    document.getElementById('saveProfileBtn').click();
    void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const savedGoal = await mainWin.webContents.executeJavaScript("document.getElementById('goalNum').textContent");
  if (db.settings.cupMl !== 250 || savedGoal !== '4') {
    throw new Error(`保存设定后目标杯数未更新：${savedGoal}`);
  }
  const beforeDrinkCount = db.drinkCount;
  await mainWin.webContents.executeJavaScript("document.getElementById('drinkBtn').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (db.drinkCount !== beforeDrinkCount + 1 || !lastUndo) throw new Error('主界面打卡验证失败');
  fs.writeFileSync(path.join(out, 'shot-undo.png'), (await mainWin.webContents.capturePage()).toPNG());
  await mainWin.webContents.executeJavaScript("document.getElementById('toastAction').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (db.drinkCount !== beforeDrinkCount || lastUndo) throw new Error('主界面撤销验证失败');
  await mainWin.webContents.executeJavaScript(`
    window.confirm = () => true;
    document.getElementById('resetTodayBtn').click();
    void 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (db.drinkCount !== 0 || db.consumedMl !== 0 || db.lastDrinkAt !== null) {
    throw new Error('今日记录重置验证失败');
  }
  await mainWin.webContents.executeJavaScript("document.getElementById('collapseHead').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 700));
  fs.writeFileSync(path.join(out, 'shot-main-open.png'), (await mainWin.webContents.capturePage()).toPNG());
  await mainWin.webContents.executeJavaScript("document.querySelector('.content').scrollTop = document.querySelector('.content').scrollHeight; void 0;");
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.writeFileSync(path.join(out, 'shot-settings-bottom.png'), (await mainWin.webContents.capturePage()).toPNG());
  reminderActive = true;
  positionReminder();
  remWin.webContents.send('reminder', {
    text: '该喝水啦！先喝一杯，再起身走两步。你的肩颈和水滴君都会感谢你。',
    sound: false,
    cupMl: 200,
    sedentaryEnabled: true,
  });
  remWin.showInactive();
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SHOT_REMINDER_WAIT_MS || 2200)));
  fs.writeFileSync(path.join(out, 'shot-reminder.png'), (await remWin.webContents.capturePage()).toPNG());
  await remWin.webContents.executeJavaScript("document.getElementById('btnSnooze').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 180));
  const snoozeMenuBounds = await remWin.webContents.executeJavaScript(`(() => {
    const menu = document.getElementById('snoozeMenu');
    const rect = document.getElementById('snoozeMenu').getBoundingClientRect();
    return {
      expanded: document.getElementById('btnSnooze').getAttribute('aria-expanded'),
      hidden: menu.hidden,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  })()`);
  if (
    snoozeMenuBounds.expanded !== 'true'
    || snoozeMenuBounds.hidden
    || snoozeMenuBounds.left < 0
    || snoozeMenuBounds.top < 0
    || snoozeMenuBounds.right > snoozeMenuBounds.width
    || snoozeMenuBounds.bottom > snoozeMenuBounds.height
  ) {
    throw new Error(`延后菜单超出提醒窗口：${JSON.stringify(snoozeMenuBounds)}`);
  }
  fs.writeFileSync(
    path.join(out, 'shot-reminder-snooze-menu.png'),
    (await remWin.webContents.capturePage()).toPNG(),
  );
  await mainWin.webContents.executeJavaScript("document.getElementById('drinkBtn').click(); void 0;");
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (reminderActive || isReminderVisible()) throw new Error('外部打卡未关闭现有提醒');
  quitting = true;
  app.quit();
}

/* ---------- 启动 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.setAppUserModelId('com.suibunhokyuka.gokugoku');
  app.whenReady().then(() => {
    load();
    // 便携目录搬走后，Run 键仍指向旧 exe；开机项开着就按当前路径重写。
    if (db.settings.autoLaunch) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
      } catch { /* 开发环境可能不支持 */ }
    }
    createWindows();
    createTray();
    setupIpc();
    tickTimer = setInterval(tick, 1000);
    tick();
    if (process.env.SHOT) {
      shotMode().catch((error) => {
        console.error(error);
        quitting = true;
        app.exit(1);
      });
    }
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(tickTimer);
    clearTimeout(saveTimer);
    if (!persistenceError) writeDatabaseAtomic();
  });
}
