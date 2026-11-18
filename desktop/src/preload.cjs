// Exposes exactly the functions declared by ipc.ts. The page gets no Electron object, no Node
// globals, and no way to construct argv: each function invokes one fixed channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ragDocs', {
	ask: (question) => ipcRenderer.invoke('rag.ask', question),
	cancelAsk: () => ipcRenderer.invoke('rag.cancelAsk'),
	documents: () => ipcRenderer.invoke('rag.documents'),
	filing: () => ipcRenderer.invoke('rag.filingShow'),
	saveFiling: (draft, check) => ipcRenderer.invoke('rag.filingSave', draft, check),
	dryRun: () => ipcRenderer.invoke('rag.dryRun'),
	resort: () => ipcRenderer.invoke('rag.resort'),
	settings: () => ipcRenderer.invoke('rag.settings'),
	setSetting: (name, value) => ipcRenderer.invoke('rag.setSetting', name, value),
});