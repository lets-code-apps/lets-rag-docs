// Renderer: the page is sandboxed and has no Node. It talks to main only through `window.ragDocs`,
// and every engine string is written with `textContent`, never as HTML.
const api = window.ragDocs;
const els = {
	answer: document.getElementById('answer'),
	citations: document.getElementById('citations'),
	libraryRows: document.getElementById('libraryRows'),
	filingRows: document.getElementById('filingRows'),
	filingNotice: document.getElementById('filingNotice'),
	filingPreview: document.getElementById('filingPreview'),
	saveErrors: document.getElementById('saveErrors'),
	askScreen: document.getElementById('askScreen'),
	filingScreen: document.getElementById('filingScreen'),
};

function clear(el) {
	el.replaceChildren();
}

function textRow(text) {
	const row = document.createElement('div');
	row.className = 'row';
	row.textContent = text;
	return row;
}

function setText(el, text) {
	el.textContent = text;
}

function showAsk() {
	els.askScreen.hidden = false;
	els.filingScreen.hidden = true;
}

function showFiling() {
	els.filingScreen.hidden = false;
	els.askScreen.hidden = true;
}

function renderLibrary(result) {
	if (!result || !result.ok) {
		setText(els.answer, result && result.error ? String(result.error) : 'Library unavailable.');
		clear(els.libraryRows);
		return;
	}
	const docs = (result.report && result.report.documents) || [];
	clear(els.libraryRows);
	docs.forEach((doc) => {
		const folder = doc.folder || 'unsorted';
		const owner = doc.owner || 'shared';
		const filed = doc.filed_as || `${folder}/${owner}/...`;
		els.libraryRows.appendChild(textRow(`${doc.path} - ${doc.title} (${folder}/${owner}) filed as ${filed}`));
	});
}

function renderAsk(result) {
	if (!result || !result.ok) {
		setText(els.answer, result && result.error ? String(result.error) : 'Ask unavailable.');
		clear(els.citations);
		return;
	}
	setText(els.answer, String(result.report.answer ?? 'No answer yet.'));
	clear(els.citations);
	for (const source of result.report.sources || []) {
		els.citations.appendChild(textRow(`${source.source} [${source.file}, chunk ${source.chunk}] score ${source.score}`));
	}
}

function renderFiling(result) {
	if (!result || !result.ok) {
		setText(els.filingNotice, result && result.error ? String(result.error) : 'Filing unavailable.');
		clear(els.filingRows);
		return;
	}
	const r = result.report;
	setText(els.filingNotice, '');
	clear(els.filingRows);
	(r.folders || []).forEach((folder) => els.filingRows.appendChild(textRow(`folder: ${folder}`)));
	(r.owners || []).forEach((owner) => els.filingRows.appendChild(textRow(`owner: ${owner}`)));
	els.filingRows.appendChild(textRow(`shared owner: ${r.shared_owner}`));
}

function renderDryRun(result) {
	if (!result || !result.ok) {
		setText(els.filingNotice, result && result.error ? String(result.error) : 'Dry-run unavailable.');
		clear(els.filingPreview);
		return;
	}
	const counts = (result.report && result.report.counts) || {};
	const moves = (counts.would_copy || 0) + (counts.would_move || 0);
	setText(els.filingNotice, moves > 0 ? `${moves} document(s) would move; renames need \`classify --force\` to re-classify stored rows.` : 'No re-sort needed.');
	clear(els.filingPreview);
	(result.report.items || []).slice(0, 200).forEach((item) => {
		els.filingPreview.appendChild(textRow(`${item.action}: ${item.from} -> ${item.to || 'unsorted'}`));
	});
	const more = Math.max(((result.report.items || []).length) - 200, 0);
	if (more > 0) els.filingPreview.appendChild(textRow(`and ${more} more`));
}

function renderSave(result) {
	if (!result || !result.ok) {
		clear(els.saveErrors);
		els.saveErrors.appendChild(textRow(result && result.error ? String(result.error) : 'Save unavailable.'));
		return;
	}
	clear(els.saveErrors);
	if (result.report.ok) {
		els.saveErrors.appendChild(textRow(`saved: ${result.report.saved ? 'yes' : 'no'}`));
		return;
	}
	for (const error of result.report.errors || []) {
		els.saveErrors.appendChild(textRow(`${error.list} ${error.code}: ${error.message}`));
	}
}

document.getElementById('askView').addEventListener('click', () => {
	showAsk();
	void api.documents().then(renderLibrary);
	void api.ask('Example question?').then(renderAsk);
});

document.getElementById('filingView').addEventListener('click', () => {
	showFiling();
	void api.filing().then(renderFiling);
	void api.dryRun().then(renderDryRun);
});

document.getElementById('saveDraftButton').addEventListener('click', () => {
	void api.saveFiling({ folders: [], owners: [] }, true).then(renderSave);
});

document.getElementById('resortButton').addEventListener('click', async () => {
	const result = await api.resort();
	if (result && !result.ok) {
		setText(els.filingNotice, String(result.error || 'Apply refused.'));
		return;
	}
	void api.dryRun().then(renderDryRun);
});

void api.documents().then(renderLibrary);
void api.filing().then(renderFiling);