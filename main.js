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
function effectiveIntervalMs() {
  return Number(db.settings.intervalMin) * 60_000;
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

function fireReminder() {
  if (!remWin || remWin.isDestroyed() || !db.profileCompleted || persistenceError) return;
  const availability = getReminderAvailability(new Date(), db.settings);
  if (!availability.allowed || goalDone() || Number(pausedUntil) > Date.now()) return;

  const text = pickReminder().replace('{mins}', String(minutesSinceDrink()));
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
      const { createShotMode } = require('./scripts/shot-mode.js');
      const shotMode = createShotMode({
        appRoot: __dirname,
        mainWin,
        remWin,
        db,
        get tickTimer() { return tickTimer; },
        set tickTimer(value) { tickTimer = value; },
        get reminderActive() { return reminderActive; },
        set reminderActive(value) { reminderActive = value; },
        get lastUndo() { return lastUndo; },
        get quitting() { return quitting; },
        set quitting(value) { quitting = value; },
        tick,
        pushState,
        positionReminder,
        isReminderVisible,
      });
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
    if (!persistenceError) writeDatabaseAtomic();
  });
}
