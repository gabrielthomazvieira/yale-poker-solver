// preload.js
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runSolver: (netid) => ipcRenderer.invoke('run-solver', netid),
  onProgressUpdate: (callback) => ipcRenderer.on('progress-update', callback),
  login: (netid) => ipcRenderer.invoke('login', netid),
  openSolverWindow: () => ipcRenderer.invoke('open-solver-window'),
  getNetID: () => ipcRenderer.invoke('get-netid'),
  applyFlopBoard: (flopBoard) =>
      ipcRenderer.invoke('apply-flop-board', flopBoard),
  openConfigWindow: () => ipcRenderer.invoke('open-config-window'),
  getConfigData: () => ipcRenderer.invoke('get-config-data'),
  applyConfigurations: (config) =>
      ipcRenderer.invoke('apply-configurations', config),
  onEquityData: (cb) => ipcRenderer.on('equity-data', cb),
  runEquity: (turn, river) => ipcRenderer.invoke('run-equity', turn, river),
  getSubtree: (path) => ipcRenderer.invoke('lazy:subtree', path),
  onRootTree: (cb) => ipcRenderer.on('root-tree', cb),
  listSampleSolutions: () => ipcRenderer.invoke('sample:list'),
  loadSampleSolution: (n) => ipcRenderer.invoke('sample:load', n),
  getSampleFlop: (n) => ipcRenderer.invoke('sample:flop', n),
  saveSampleSolution: () => ipcRenderer.invoke('sample:save'),
  submitTitle: (title) => ipcRenderer.send('submit-title', title),
  onSampleSavedUpdateList: (callback) =>
      ipcRenderer.on('sample-saved-update-list', callback),
  onError: (callback) => ipcRenderer.on('error-message', callback),
  openRangeEditor: (data) => ipcRenderer.invoke('open-range-editor', data),
  applyRangeString: (data) => ipcRenderer.invoke('apply-range-string', data),
  onInitialRangeData: (callback) =>
      ipcRenderer.on('initial-range-data', (_event, data) => callback(data)),
  onUpdateConfigRangeField: (callback) => ipcRenderer.on(
      'update-config-range-field', (_event, data) => callback(data)),
});

// chatbot
contextBridge.exposeInMainWorld(
    'secrets', {openRouterKey: process.env.OPENAI_API_KEY || ''});
contextBridge.exposeInMainWorld(
    'deepseek', {ask: (prompt) => ipcRenderer.invoke('deepseek:ask', prompt)});
