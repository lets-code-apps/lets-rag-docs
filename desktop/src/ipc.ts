// The one place that names the messages crossing the main <-> renderer boundary. Main, preload
// and the tests all agree through these constants. No `electron` import: pure data.

import type {
	AddReport,
	AskReport,
	DocumentsReport,
	FilingSaveReport,
	FilingShowReport,
	LocateReport,
	ModelDetectReport,
	ModelSaveReport,
	OrganizeReport,
	SetupSaveReport,
	SetupShowReport,
	SearchReport,
	StatusReport,
} from './reports.ts';
import type { PullStatus } from './pull.ts';
import type { Appearance } from './settings.ts';

export const IPC = {
	ask: 'rag.ask',
	cancelAsk: 'rag.cancelAsk',
	documents: 'rag.documents',
	status: 'rag.status',
	search: 'rag.search',
	filingShow: 'rag.filingShow',
	filingSave: 'rag.filingSave',
	dryRun: 'rag.dryRun',
	resort: 'rag.resort',
	pickFiles: 'rag.pickFiles',
	addNext: 'rag.addNext',
	cancelAdd: 'rag.cancelAdd',
	openDocument: 'rag.openDocument',
	settings: 'rag.settings',
	setSetting: 'rag.setSetting',
	// First-run onboarding (LET-136). Each maps to one engine subcommand except setupComplete,
	// which records setupDone through the settings controller. modelPull is the streaming download;
	// cancelPull stops it and modelPullStatus reads its live progress without re-parsing any line.
	setupShow: 'rag.setupShow',
	setupSave: 'rag.setupSave',
	modelDetect: 'rag.modelDetect',
	modelSave: 'rag.modelSave',
	modelPull: 'rag.modelPull',
	cancelPull: 'rag.cancelPull',
	modelPullStatus: 'rag.modelPullStatus',
	setupComplete: 'rag.setupComplete',
	// modelSetup writes only what the user chose (library, watch, optional owner, optional model) and
	// records setupDone — in that fixed order, through the same jobs bracket a filing save uses. It runs
	// at the last "continue", so quitting mid-onboarding leaves no half setup.
	modelSetup: 'rag.modelSetup',
	// Two host seams, not engine subcommands: pickFolder opens the OS folder picker and answers the chosen
	// path (main converts it to `~/` form); installOllama hands the one fixed Ollama URL to the OS browser.
	pickFolder: 'rag.pickFolder',
	installOllama: 'rag.installOllama',
} as const;

export type AskResult = { ok: boolean; error?: string; report?: AskReport };
export type DocumentsResult = { ok: boolean; error?: string; report?: DocumentsReport };
export type StatusResult = { ok: boolean; error?: string; report?: StatusReport };
export type SearchResult = { ok: boolean; error?: string; report?: SearchReport };
export type FilingShowResult = { ok: boolean; error?: string; report?: FilingShowReport };
export type FilingSaveResult = { ok: boolean; error?: string; report?: FilingSaveReport };
export type DryRunResult = { ok: boolean; error?: string; report?: OrganizeReport; stale?: boolean };
export type ResortResult = { ok: boolean; error?: string; report?: OrganizeReport };
export type CancelResult = { ok: boolean; cancelled: boolean; error?: string };

// Add is a queue main fills from its own file picker: the page learns only the count and the display
// names, then asks for the next result. Paths cross main -> engine and never the other way.
export type PickFilesResult = { ok: boolean; error?: string; count?: number; names?: string[] };
export type AddNextResult = {
	ok: boolean;
	error?: string;
	done?: boolean;
	index?: number;
	total?: number;
	name?: string;
	outcome?: string;
	report?: AddReport;
};
// The renderer names a document it already displays; main resolves the real file (engine `locate`)
// and opens it. `opened` is what the OS reported.
export type OpenDocumentResult = { ok: boolean; error?: string; opened?: boolean };

// The settings the page reads and writes. `appearance` is ours (system|dark|light); `openAtLogin`
// is read from, and written back to, the OS login item — the payload always reports the OS's real
// state, never a remembered one. `setupDone` tells the boot gate whether first-run onboarding has
// finished; only main ever writes it.
export type SettingsPayload = { appearance: Appearance; openAtLogin: boolean; setupDone: boolean };

// The `settings` channel answers with the payload plus `memGb`: the machine's memory in whole GB,
// read from the main-only host (`memoryBytes`), the same host pattern as the folder picker. The onboarding
// model step uses it to name the memory-sized recommendation; smoke/shots fix it at 16 GiB, so both
// apps and the screenshots recommend alike. It is a host answer, never a stored setting.
export type SettingsInfo = SettingsPayload & { memGb: number };

// First-run onboarding payloads (each a parsed engine report, or a clean error string).
export type SetupShowResult = { ok: boolean; error?: string; report?: SetupShowReport };
export type SetupSaveResult = { ok: boolean; error?: string; report?: SetupSaveReport };
export type ModelDetectResult = { ok: boolean; error?: string; report?: ModelDetectReport };
export type ModelSaveResult = { ok: boolean; error?: string; report?: ModelSaveReport };
// A pull answers with the outcome (did the server confirm success, and if not why). Progress is polled
// separately through modelPullStatus, so the page's bar can move without waiting for the download to end.
export type ModelPullResult = { ok: boolean; error?: string; success?: boolean; reason?: string | null };
// The live download bar: engine-owned numbers the page paints as data (never HTML).
export type PullStatusResult = PullStatus;
// setupComplete records setupDone=true and returns the settings payload, or null if refused.
export type SetupCompleteResult = SettingsPayload | null;
// modelSetup writes the chosen fields in a fixed order and reports how far it got. On a stop the page
// stays on the step that failed and can continue again safely (an unchanged save writes nothing).
export type ModelSetupResult = { ok: boolean; step?: string; error?: string };
// pickFolder answers the chosen directory (already in `~/` form) or says the user cancelled. installOllama
// just reports the hand-off; the URL is fixed in main and never built from input.
export type PickFolderResult = { ok: boolean; canceled?: boolean; path?: string };
export type InstallOllamaResult = { ok: boolean };

export type IPCFunctionName =
	| 'ask'
	| 'cancelAsk'
	| 'documents'
	| 'status'
	| 'search'
	| 'filing'
	| 'saveFiling'
	| 'dryRun'
	| 'resort'
	| 'pickFiles'
	| 'addNext'
	| 'cancelAdd'
	| 'openDocument'
	| 'settings'
	| 'setSetting'
	| 'setupShow'
	| 'setupSave'
	| 'modelDetect'
	| 'modelSave'
	| 'modelPull'
	| 'cancelPull'
	| 'modelPullStatus'
	| 'completeSetup'
	| 'modelSetup'
	| 'pickFolder'
	| 'installOllama';