// Exposes exactly the functions declared by ipc.ts. The page gets no Electron object, no Node
// globals, and no way to construct argv: each function invokes one fixed channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ragDocs', {
	ask: (question) => ipcRenderer.invoke('rag.ask', question),
	cancelAsk: () => ipcRenderer.invoke('rag.cancelAsk'),
	documents: () => ipcRenderer.invoke('rag.documents'),
	status: () => ipcRenderer.invoke('rag.status'),
	search: (query) => ipcRenderer.invoke('rag.search', query),
	filing: () => ipcRenderer.invoke('rag.filingShow'),
	saveFiling: (draft, check) => ipcRenderer.invoke('rag.filingSave', draft, check),
	dryRun: () => ipcRenderer.invoke('rag.dryRun'),
	resort: () => ipcRenderer.invoke('rag.resort'),
	pickFiles: () => ipcRenderer.invoke('rag.pickFiles'),
	addNext: () => ipcRenderer.invoke('rag.addNext'),
	cancelAdd: () => ipcRenderer.invoke('rag.cancelAdd'),
	openDocument: (path) => ipcRenderer.invoke('rag.openDocument', path),
	settings: () => ipcRenderer.invoke('rag.settings'),
	setSetting: (name, value) => ipcRenderer.invoke('rag.setSetting', name, value),
	// First-run onboarding. The channel strings must match src/ipc.ts (IPC); test/boundaries.test.ts keeps
	// them in sync. modelPull starts the download; cancelPull stops it; modelPullStatus reads the bar.
	setupShow: () => ipcRenderer.invoke('rag.setupShow'),
	setupSave: (draft, check) => ipcRenderer.invoke('rag.setupSave', draft, check),
	modelDetect: (url) => ipcRenderer.invoke('rag.modelDetect', url),
	modelSave: (runtime, url, model) => ipcRenderer.invoke('rag.modelSave', runtime, url, model),
	modelPull: (model, url) => ipcRenderer.invoke('rag.modelPull', model, url),
	cancelPull: () => ipcRenderer.invoke('rag.cancelPull'),
	modelPullStatus: () => ipcRenderer.invoke('rag.modelPullStatus'),
	completeSetup: () => ipcRenderer.invoke('rag.setupComplete'),
	// The last step: send the collected choices; main runs the engine writes in a fixed order.
	modelSetup: (input) => ipcRenderer.invoke('rag.modelSetup', input),
	// Two host seams: the OS folder picker, and the one fixed Ollama install link opened in the browser.
	pickFolder: () => ipcRenderer.invoke('rag.pickFolder'),
	installOllama: () => ipcRenderer.invoke('rag.installOllama'),
});