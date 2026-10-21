'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scribe', {
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupStart: () => ipcRenderer.invoke('setup:start'),
  setupCancel: () => ipcRenderer.invoke('setup:cancel'),
  onSetupProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },

  meetingAvailable: () => ipcRenderer.invoke('meeting:available'),
  meetingSources: () => ipcRenderer.invoke('meeting:sources'),
  meetingStart: (appKeys, mic, micId, micOnly = false) => ipcRenderer.invoke('meeting:start', { appKeys, mic, micId, micOnly }),
  listMics: () => ipcRenderer.invoke('capture:mics'),
  meetingStop: () => ipcRenderer.invoke('meeting:stop'),
  meetingDiscard: () => ipcRenderer.invoke('meeting:discard'),
  onMeetingStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('meeting:status', handler);
    return () => ipcRenderer.removeListener('meeting:status', handler);
  },
  onLiveSegments: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('live:segments', handler);
    return () => ipcRenderer.removeListener('live:segments', handler);
  },
  onLiveNotice: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('live:notice', handler);
    return () => ipcRenderer.removeListener('live:notice', handler);
  },
  runTracks: (tracks, title, sourceName, templateId) => ipcRenderer.invoke('pipeline:run', { tracks, title, sourceName, templateId }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('models:list'),
  testOllama: (host) => ipcRenderer.invoke('ollama:test', host),

  pickAudio: () => ipcRenderer.invoke('dialog:pickAudio'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  saveRecording: (buffer) => ipcRenderer.invoke('recording:save', buffer),

  run: (inputPath, title, templateId) => ipcRenderer.invoke('pipeline:run', { inputPath, title, templateId }),
  rerunSummary: (id, templateId) => ipcRenderer.invoke('pipeline:resummarize', { id, templateId }),
  cancel: () => ipcRenderer.invoke('pipeline:cancel'),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('pipeline:progress', handler);
    return () => ipcRenderer.removeListener('pipeline:progress', handler);
  },

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSpeaker: (id, from, to) => ipcRenderer.invoke('sessions:rename-speaker', { id, from, to }),
  onSessionsChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('sessions:changed', handler);
    return () => ipcRenderer.removeListener('sessions:changed', handler);
  },

  listTemplates: () => ipcRenderer.invoke('templates:list'),
  saveTemplate: (t) => ipcRenderer.invoke('templates:save', t),
  deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),

  sendToNotes: (id) => ipcRenderer.invoke('share:notes', id),
  notesVaults: () => ipcRenderer.invoke('notes:vaults'),
  sendToDrive: (opts) => ipcRenderer.invoke('share:drive', opts),
  driveTest: (address, token) => ipcRenderer.invoke('drive:test', { address, token }),
  driveTokenStatus: () => ipcRenderer.invoke('drive:token-status'),
  driveSetToken: (token) => ipcRenderer.invoke('drive:set-token', token),
  openInClaude: (id) => ipcRenderer.invoke('share:claude', id),
  exportMarkdown: (id) => ipcRenderer.invoke('share:export', id),
  exportFormats: () => ipcRenderer.invoke('export:formats'),
  exportAudio: (id, format) => ipcRenderer.invoke('export:audio', { id, format }),
  exportTranscript: (id, format) => ipcRenderer.invoke('export:transcript', { id, format }),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
});
