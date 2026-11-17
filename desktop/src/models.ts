// Renderer-facing view models. The engine reports are data; models.ts turns them into strings and
// counts the page can print. Everything here is pure and unit-tested. `SAMPLE` marks the only
// values the engine cannot supply yet; the renderer must attach a visible "Sample data" pill and
// `data-sample="true"` wherever one of these appears.

import type { AskReport, DocumentsReport, FilingShowReport, FilingSaveReport, OrganizeReport } from './reports.ts';

export const SAMPLE = {
	citationSnippet: 'The engine cites source and chunk; snippet text is sample data.',
	documentSize: 'The engine reports no document size yet.',
	indexHealth: 'The engine does not expose index freshness yet.',
} as const;

export type LibraryView = {
	rows: { path: string; label: string; filed: string }[];
	folderCounts: { name: string; count: number }[];
};

export type AskView = {
	answer: string;
	citations: { label: string; score: string }[];
};

export type FilingView = {
	folders: string[];
	owners: string[];
	sharedOwner: string;
	notice: string | null;
	preview: { from: string; to: string }[];
	more: number;
};

export type SaveView = {
	rows: string[];
	errors: { list: string; label: string; message: string }[];
	saved: boolean;
};

export function libraryView(report: DocumentsReport): LibraryView {
	const counts = new Map<string, number>();
	const rows: LibraryView['rows'] = [];
	for (const doc of report.documents) {
		const folder = doc.folder ?? 'unsorted';
		const owner = doc.owner ?? 'shared';
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
		rows.push({
			path: doc.path,
			label: `${doc.path} - ${doc.title}`,
			filed: doc.filed_as ?? `${folder}/${owner ?? 'shared'}/...`,
		});
	}
	const folderCounts = [...counts.entries()].map(([name, count]) => ({ name, count }));
	return { rows, folderCounts };
}

export function askView(report: AskReport): AskView {
	return {
		answer: report.answer ?? 'No answer yet.',
		citations: report.sources.map((source) => ({
			label: `${source.source} [${source.file}, chunk ${source.chunk}]`,
			score: source.score.toFixed(2),
		})),
	};
}

export function filingView(show: FilingShowReport, dryRun: OrganizeReport | null, saveErrors: SaveView['errors']): FilingView {
	const notice = dryRun ? reSortNotice(dryRun) : null;
	const preview = dryRun ? dryRunPreview(dryRun).rows : [];
	const more = dryRun ? Math.max(dryRun.items.length - 200, 0) : 0;
	return {
		folders: show.folders,
		owners: show.owners,
		sharedOwner: show.shared_owner,
		notice,
		preview,
		more,
	};
}

export function saveView(report: FilingSaveReport): SaveView {
	const rows = [
		`folders: ${report.folders.join(', ')}`,
		`owners: ${report.owners.join(', ')}`,
	];
	const errors = report.errors.map((error) => ({
		list: error.list,
		label: `${error.list}${error.index === null ? '' : ` ${error.index + 1}`}${error.name === null ? '' : ` (${error.name})`}`,
		message: error.message,
	}));
	return { rows, errors, saved: report.saved };
}

export function reSortNotice(dryRun: OrganizeReport): string | null {
	const moves = (dryRun.counts.would_copy ?? 0) + (dryRun.counts.would_move ?? 0);
	if (moves === 0) return null;
	return `${moves} document(s) would move; renames do not re-classify until \`classify --force\`.`;
}

export function dryRunPreview(dryRun: OrganizeReport): { rows: { from: string; to: string }[] } {
	return {
		rows: dryRun.items.slice(0, 200).map((item) => ({ from: item.from, to: item.to ?? 'unsorted' })),
	};
}