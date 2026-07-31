'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  drink: () => ipcRenderer.invoke('drink'),
  undoDrink: (id) => ipcRenderer.invoke('undo-drink', id),
  resetToday: () => ipcRenderer.invoke('reset-today'),
  saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  reminderAction: (action, snoozeMinutes) => ipcRenderer.invoke('reminder-action', action, snoozeMinutes),
  reminderDone: () => ipcRenderer.invoke('reminder-done'),
  winMin: () => ipcRenderer.invoke('win-min'),
  winHide: () => ipcRenderer.invoke('win-hide'),
  setExpand: (open) => ipcRenderer.invoke('set-expand', open),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onReminder: (cb) => ipcRenderer.on('reminder', (_e, p) => cb(p)),
  onReminderCancel: (cb) => ipcRenderer.on('reminder-cancel', () => cb()),
});
