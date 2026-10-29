'use strict';

const fs = require('fs');
const path = require('path');
const { app, screen } = require('electron');

function createShotMode(runtime) {
  const { tick, pushState, positionReminder, isReminderVisible } = runtime;
  const mainWin = runtime.mainWin;
  const remWin = runtime.remWin;
  const db = runtime.db;

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
    clearInterval(runtime.tickTimer);
    runtime.tickTimer = null;
    if (mainWin.webContents.isLoading()) {
      await new Promise((resolve) => mainWin.webContents.once('did-finish-load', resolve));
    }
    const out = process.env.SHOT_DIR || runtime.appRoot;
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
    if (db.drinkCount !== beforeDrinkCount + 1 || !runtime.lastUndo) throw new Error('主界面打卡验证失败');
    fs.writeFileSync(path.join(out, 'shot-undo.png'), (await mainWin.webContents.capturePage()).toPNG());
    await mainWin.webContents.executeJavaScript("document.getElementById('toastAction').click(); void 0;");
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (db.drinkCount !== beforeDrinkCount || runtime.lastUndo) throw new Error('主界面撤销验证失败');
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
    runtime.reminderActive = true;
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
    if (runtime.reminderActive || isReminderVisible()) throw new Error('外部打卡未关闭现有提醒');
    runtime.quitting = true;
    app.quit();
  }

  return shotMode;
}

module.exports = {
  createShotMode,
};
