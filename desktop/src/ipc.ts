// The one place that names the messages crossing the main <-> renderer boundary. Main, preload
// and the tests all agree through these constants. No `electron` import: pure data.

import type {
	AskReport,
	DocumentsReport,
	FilingSaveReport,
	FilingShowReport,
	OrganizeReport,
} from './reports.ts';

export const IPC = {
	ask: 'rag.ask',
	cancelAsk: 'rag.cancelAsk',
	documents: 'rag.documents',
	filingShow: 'rag.filingShow',
	filingSave: 'rag.filingSave',
	dryRun: 'rag.dryRun',
	resort: 'rag.resort',
} as const;

export type AskResult = { ok: boolean; error?: string; report?: AskReport };
export type DocumentsResult = { ok: boolean; error?: string; report?: DocumentsReport };
export type FilingShowResult = { ok: boolean; error?: string; report?: FilingShowReport };
export type FilingSaveResult = { ok: boolean; error?: string; report?: FilingSaveReport };
export type DryRunResult = { ok: boolean; error?: string; report?: OrganizeReport };
export type ResortResult = { ok: boolean; error?: string; report?: OrganizeReport };
export type CancelResult = { ok: boolean; cancelled: boolean; error?: string };

export type IPCFunctionName =
	| 'ask'
	| 'cancelAsk'
	| 'documents'
	| 'filing'
	| 'saveFiling'
	| 'dryRun'
	| 'resort';