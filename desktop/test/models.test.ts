import assert from 'node:assert/strict';
import { test } from 'node:test';

import { askView, filingView, libraryView, reSortNotice, SAMPLE } from '../src/models.ts';
import type { AskReport, DocumentsReport, FilingShowReport, OrganizeReport } from '../src/reports.ts';

test('library view groups rows and counts', () => {
	const report: DocumentsReport = {
		version: 1,
		status: 'ok',
		documents: [
			{ path: 'a.pdf', title: 'Invoice', type: 'invoice', date: null, folder: 'Home', owner: 'Alex Example', filed_as: 'Home/Alex Example/2025/a.pdf' },
			{ path: 'b.pdf', title: 'Letter', type: 'letter', date: null, folder: null, owner: null, filed_as: null },
		],
	};
	const view = libraryView(report);
	assert.equal(view.rows.length, 2);
	assert.match(view.rows[0].filed, /Home\/Alex Example/);
	assert.match(view.rows[1].filed, /unsorted\/shared/);
	assert.deepEqual(view.folderCounts, [{ name: 'Home', count: 1 }, { name: 'unsorted', count: 1 }]);
});

test('ask view keeps citations', () => {
	const view = askView({ version: 1, answer: 'Blue. [manual, chunk 2]', sources: [{ source: 'manual', file: 'manual.pdf.text.txt', chunk: 2, score: 0.5 }] });
	assert.equal(view.answer, 'Blue. [manual, chunk 2]');
	assert.match(view.citations[0].label, /chunk 2/);
});

test('filing view keeps shared owner and re-sort notice', () => {
	const dry: OrganizeReport = {
		version: 1,
		mode: 'dry_run',
		status: 'ok',
		items: [{ action: 'copy', from: 'one.pdf', to: 'Home/Shared/Report.pdf' }],
		counts: { would_copy: 1, would_move: 0 },
	};
	const view = filingView({ version: 1, folders: ['Home'], owners: ['Alex Example'], shared_owner: 'Shared' }, dry, []);
	assert.equal(view.sharedOwner, 'Shared');
	assert.match(view.notice ?? '', /would move/);
});

test('SAMPLE keys are declared', () => {
	assert.deepEqual(Object.keys(SAMPLE).sort(), ['citationSnippet', 'documentSize', 'indexHealth']);
});