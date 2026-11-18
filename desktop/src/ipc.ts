// The one place that names the messages crossing the main <-> renderer boundary. Main, preload
// and the tests all agree through these constants. No `electron` import: pure data.

import type { AddReport, AskReport, DocumentsReport, FilingSaveReport, FilingShowReport, LocateReport, OrganizeReport, SearchReport } from './reports.ts';
import type { Appearance } from './settings.ts';

export const IPC = {
	ask: 'rag.ask',
	cancelAsk: 'rag.cancelAsk',
	documents: 'rag.documents',
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
} as const;

export type AskResult = { ok: boolean; error?: string; report?: AskReport };
export type DocumentsResult = { ok: boolean; error?: string; report?: DocumentsReport };
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
// state, never a remembered one.
export type SettingsPayload = { appearance: Appearance; openAtLogin: boolean };

export type IPCFunctionName =
	| 'ask'
	| 'cancelAsk'
	| 'documents'
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
	| 'setSetting';