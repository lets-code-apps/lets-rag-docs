// Renderer: ask and filing screens driven by the sandboxed `window.ragDocs` bridge for live data,
// and by local synthetic demo states for the design screenshots. No HTML injection, no network.

const api = window.ragDocs;
const root = document.body;

const byId = (id) => document.getElementById(id);

function clearEl(el) {
	while (el && el.firstChild !== null) {
		el.removeChild(el.firstChild);
	}
}

function clear(id) {
	const el = byId(id);
	if (el !== null) clearEl(el);
}

function text(el, value) {
	if (el !== null) el.textContent = value;
}

function hidden(id, value) {
	const el = byId(id);
	if (value === true) el.setAttribute('hidden', '');
	else el.removeAttribute('hidden');
}

function toggleClass(id, className, add) {
	const el = byId(id);
	if (add) el.classList.add(className);
	else el.classList.remove(className);
}

function initials(title) {
	const words = title.split(/\s+/).filter((w) => w !== '');
	const fromWords = words.map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
	return fromWords !== '' ? fromWords : title.slice(0, 2).toUpperCase();
}

function makeRow(row) {
	const entry = document.createElement('div');
	entry.className = 'entryRow';

	const avatar = document.createElement('span');
	avatar.className = 'initials';
	avatar.textContent = initials(row.title);

	const main = document.createElement('div');
	main.className = 'rowMain';

	const title = document.createElement('div');
	title.className = 'rowTitle';
	title.textContent = row.title;

	const meta = document.createElement('div');
	meta.className = 'rowMeta';
	meta.textContent = row.meta ?? row.preview ?? '';

	main.appendChild(title);
	main.appendChild(meta);

	if (row.selected) entry.classList.add('selected');
	entry.appendChild(avatar);
	entry.appendChild(main);

	if (row.pill) {
		const pill = document.createElement('span');
		pill.className = 'rowPill';
		pill.textContent = row.pill;
		entry.appendChild(pill);
	}

	return entry;
}

function appendRows(targetId, rows) {
	const target = byId(targetId);
	for (const row of rows) target.appendChild(makeRow(row));
}

function appendPath(tokens) {
	const target = byId('pathTokens');
	for (const token of tokens) {
		const wrap = document.createElement('span');
		wrap.className = 'pathToken';

		const cap = document.createElement('span');
		cap.className = 'pathTokenLabel';
		cap.textContent = token.cap;

		const val = document.createElement('span');
		val.className = 'pathTokenValue';
		val.textContent = token.val;
		if (token.active) val.classList.add('active');

		wrap.appendChild(cap);
		wrap.appendChild(val);
		target.appendChild(wrap);
	}
}

function setNotice(notice) {
	const hasNotice = notice !== null && notice !== undefined;
	clear('noticePill');
	clear('moveRows');
	text(byId('noticeLabel'), hasNotice ? notice.pill : '');
	text(byId('noticeText'), hasNotice ? notice.text : '');
	text(byId('noticeNote'), hasNotice ? notice.note : '');

	if (!hasNotice) {
		hidden('noticeCard', true);
		hidden('movesSection', true);
		return;
	}

	const pill = byId('noticePill');
	pill.className = notice.danger ? 'statusPill danger' : 'statusPill attention';
	hidden('noticeCard', false);
	hidden('reSortNoticeButton', !notice.ask);
	hidden('movesSection', !notice.preview);

	if (notice.preview && notice.moves) {
		for (const move of notice.moves) {
			const row = makeRow({
				title: move.title,
				meta: `${move.to} · ${move.from}`,
				preview: move.to,
				pill: move.pill,
			});
			byId('moveRows').appendChild(row);
		}
		text(byId('moveNote'), notice.actions ? 'Only filed copies move. Originals are never touched.' : '');
		hidden('applyMoveButton', !notice.actions);
		hidden('showAllButton', !notice.actions);
		hidden('laterButton', !notice.actions);
	}
}

function setForm(form) {
	const hasForm = form !== null && form !== undefined;
	text(byId('formTitle'), hasForm ? form.title : '');
	text(byId('formMeta'), hasForm ? form.meta : '');
	text(byId('formLabel'), hasForm ? form.label : 'name');
	text(byId('formHelper'), hasForm ? form.helper : '');
	text(byId('formNote'), hasForm ? form.note : '');

	const input = byId('nameInput');
	input.value = hasForm ? form.value : '';
	if (hasForm && form.error) input.setAttribute('aria-invalid', 'true');
	else input.removeAttribute('aria-invalid');

	if (hasForm && form.error) {
		input.classList.add('isError');
		byId('formHelper').classList.add('isError');
	} else {
		input.classList.remove('isError');
		byId('formHelper').classList.remove('isError');
	}

	hidden('removeButton', !(hasForm && form.canRemove === true));
	text(byId('removeButton'), hasForm ? form.remove : 'remove');
}

function setLists(folders, owners, active) {
	currentDraft.folders = folders;
	currentDraft.owners = owners;
	currentDraft.active = active;
}

function setSwitch(view) {
	toggleClass('foldersSwitch', 'segOn', view === 'folders');
	toggleClass('ownersSwitch', 'segOn', view === 'owners');
	byId('foldersSwitch').setAttribute('aria-checked', view === 'folders' ? 'true' : 'false');
	byId('ownersSwitch').setAttribute('aria-checked', view === 'owners' ? 'true' : 'false');
}

function showView(view) {
	root.dataset.view = view;
	toggleClass('askView', 'isCurrent', view === 'ask');
	toggleClass('filingView', 'isCurrent', view === 'filing');
	hidden('askScreen', view !== 'ask');
	hidden('filingScreen', view !== 'filing');
}

const currentDraft = {
	folders: ['Finance'],
	owners: ['Shared'],
	active: 'owners',
};

const folderNames = ['Identity', 'Health', 'Finance', 'Taxes', 'Insurance', 'Home', 'Car', 'Work', 'Education', 'Purchases', 'Letters', 'Other'];
const ownerNames = ['Ava Lin', 'Studio Beta', 'Northwind LLC'];
const pathNote = 'The model picks one folder and one owner per document. Nothing moves until you preview the re-sort.';

function demoCounts(view) {
	const m = new Map();
	if (view === 'folders') {
		[6, 14, 31, 12, 9, 11, 9, 13, 5, 10, 4, 2].forEach((n, i) => m.set(folderNames[i] ?? '', n));
		m.set('Vehicles', 9);
		return m;
	}
	m.set('Ava Lin', 64);
	m.set('Studio Beta', 41);
	m.set('Northwind LLC', 15);
	return m;
}

function listRows(view, counts, shared, selected, extras) {
	const source = view === 'folders' ? folderNames : ownerNames;
	const rows = source.map((title) => ({
		title,
		meta: counts.get(title) === 1 ? '1 document' : `${counts.get(title) ?? 0} documents`,
		selected: title === selected,
		pill: extras[title] ?? '',
	}));

	if (view === 'owners') {
		rows.push({ title: shared, meta: 'Nobody on the list, or several people.', selected: selected === shared, pill: 'shared owner' });
	} else {
		rows.push({ title: 'unsorted', meta: 'Documents that fit no folder.', preview: 'Documents that fit no folder.', selected: selected === 'unsorted' });
	}
	return rows;
}

function applyDemoState(view, state) {
	root.dataset.state = `${view}-${state}`;
	if (state === 'small') root.dataset.small = 'true';
	else root.removeAttribute('data-small');

	if (view === 'ask') {
		showView('ask');
		text(byId('libraryCount'), '128 documents');
		clear('libraryRows');
		appendRows('libraryRows', [
			{ title: 'contract-2026.pdf', meta: 'Acme Corp · 12 pages', pill: 'cited' },
			{ title: 'kickoff-notes.md', meta: 'meeting notes · 2 pages', pill: 'cited' },
			{ title: 'brand-guidelines.pdf', meta: '38 pages' },
			{ title: 'q3-report.xlsx', meta: '4 sheets' },
			{ title: 'scan-0412.pdf', meta: 'scanned · 64 MB', pill: 'not indexed: over 50 MB' },
		]);
		text(byId('questionBubble'), 'What did we agree with Acme about invoice deadlines?');
		text(byId('answerMeta'), 'answer from 2 documents');
		text(byId('answer'), 'Invoices are due within 14 days of the end of each month [1]. If a deliverable slips, the invoice for that month waits until it is accepted, and the 14 days count from acceptance [2].');
		clear('citations');
		const c1 = document.createElement('span');
		c1.className = 'citation';
		c1.textContent = '[1] contract-2026.pdf, p. 4';
		const c2 = document.createElement('span');
		c2.className = 'citation';
		c2.textContent = '[2] kickoff-notes.md';
		byId('citations').appendChild(c1);
		byId('citations').appendChild(c2);
		setNotice(null);
		setForm(null);
		return;
	}

	const ownersView = state === 'owners' || state === 'owners-empty' || state === 'adding' || state === 'error' || state === 'shared';
	showView('filing');
	setSwitch(ownersView ? 'owners' : 'folders');

	const counts = demoCounts(ownersView ? 'owners' : 'folders');
	const rows = state === 'owners-empty'
		? []
		: listRows(ownersView ? 'owners' : 'folders', counts, 'Shared', state === 'folders' || state === 'editing' || state === 'small' ? (state === 'folders' || state === 'small' ? 'Finance' : 'Car') : (state === 'owners' ? 'Ava Lin' : state === 'shared' ? 'Shared' : state === 'adding' ? 'Studio Beta' : ''), {
			Car: '',
			Vehicles: 'was Car',
			'Studio Beta': 'new',
		});

	text(byId('listMeta'), state === 'owners-empty' ? '128 documents, no owners' : ownersView ? '128 documents, 3 owners' : '128 documents in 12 folders');
	clear('filingRows');
	appendRows('filingRows', rows);

	const active = ownersView ? 'owner' : 'folder';
	appendPath([
		{ cap: '', val: 'library' },
		{ cap: 'folder', val: state === 'editing' || state === 'changed' || state === 'preview' ? 'Vehicles' : 'Finance', active: active === 'folder' },
		{ cap: 'owner', val: state === 'adding' ? 'Studio Beta' : state === 'shared' ? 'Shared' : 'Ava Lin', active: active === 'owner' },
		{ cap: 'year', val: '2025' },
		{ cap: 'date, matter and title', val: 'invoice-deadlines.pdf' },
	]);
	text(byId('pathNote'), pathNote);

	if (state === 'changed') {
		setNotice({
			pill: 're-sort needed',
			text: 'You renamed Car to Vehicles and added the owner Studio Beta. The model on this Mac has to read all 128 documents again and pick from the new lists.',
			note: 'Nothing moves yet. You get a preview first, and your original files are never touched.',
			ask: true,
		});
		setForm(null);
		return;
	}

	if (state === 'preview') {
		setNotice({
			pill: '14 copies will move',
			text: 'Re-sorting is done. Check the moves below, then apply them.',
			note: 'Only the filed copies move. Originals are never touched, and a copy you edited after filing is never removed.',
			preview: true,
			actions: true,
			moves: [
				{ title: 'invoice-deadlines.pdf', from: 'from Car / Ava Lin / 2025', to: 'to Vehicles / Ava Lin / 2025' },
				{ title: 'invoice-vat.pdf', from: 'from Finance / Shared / 2025', to: 'to Finance / Studio Beta / 2025' },
				{ title: 'inspection-cert.pdf', from: 'from Car / Northwind LLC / 2024', to: 'to Vehicles / Northwind LLC / 2024', pill: 'old copy stays: you edited it' },
			],
		});
		setForm(null);
		return;
	}

	setNotice(null);
	if (state === 'owners-empty') {
		setForm({ title: 'add owner', meta: 'Spell it the way the folder should read.', label: 'owner name', value: '', note: 'Until owners exist, every copy is filed under Shared.' });
	} else if (state === 'adding' || state === 'error') {
		setForm({
			title: 'add owner',
			meta: 'Spell it the way the folder should read.',
			label: 'owner name',
			value: state === 'error' ? 'Studio/Beta' : 'Studio Beta',
			helper: state === 'error' ? 'Take out the "/". The name becomes a folder, so it can\'t contain "/" or start or end with a dot.' : '',
			error: state === 'error',
			note: 'Saving changes the lists only. Documents are re-sorted when you ask, and nothing moves before you see the preview.',
		});
	} else if (state === 'shared') {
		setForm({ title: 'Shared', meta: '8 documents filed here', label: 'shared folder name', value: 'Shared', helper: 'For documents that belong to nobody on the list, or to several people.', note: 'The shared owner catches the rest.' });
	} else if (state === 'editing') {
		setForm({ title: 'Car', meta: '9 documents filed here', label: 'folder name', value: 'Vehicles', canRemove: true, remove: 'remove folder', note: 'Removing a folder deletes no documents. They are re-sorted into the folders that are left.' });
	} else if (state === 'owners') {
		setForm({ title: 'Ava Lin', meta: '64 documents filed here', label: 'owner name', value: 'Ava Lin', canRemove: true, remove: 'remove owner', note: 'Removing an owner deletes no documents. They are re-sorted to the owners that are left, or to Shared.' });
	} else {
		setForm({ title: 'Finance', meta: '31 documents filed here', label: 'folder name', value: 'Finance', canRemove: true, remove: 'remove folder', note: 'Removing a folder deletes no documents. They are re-sorted into the folders that are left.' });
	}
}

window.applyDemoState = applyDemoState;

function renderDocuments(result) {
	text(byId('libraryCount'), `${result?.report?.documents?.length ?? 0} documents`);
	clear('libraryRows');
	const docs = result?.report?.documents ?? [];
	if (docs.length === 0) {
		const row = document.createElement('div');
		row.className = 'entryRow';
		const main = document.createElement('div');
		main.className = 'rowMain';
		const title = document.createElement('div');
		title.className = 'rowTitle';
		title.textContent = 'No documents yet.';
		main.appendChild(title);
		row.appendChild(main);
		byId('libraryRows').appendChild(row);
		return;
	}
	for (const doc of docs) {
		appendRows('libraryRows', [{
			title: doc.title,
			meta: `${doc.folder ?? 'unsorted'} / ${doc.owner ?? 'shared'}`,
			preview: doc.filed_as ?? '',
		}]);
	}
}

function renderAsk(result) {
	text(byId('answer'), result?.report?.answer ?? 'No answer yet.');
	clear('citations');
	for (const source of result?.report?.sources ?? []) {
		const pill = document.createElement('span');
		pill.className = 'citation';
		pill.textContent = `${source.source} [${source.file}, chunk ${source.chunk}] score ${source.score.toFixed(2)}`;
		byId('citations').appendChild(pill);
	}
}

function renderFilingShow(result) {
	if (!result?.ok) {
		text(byId('listMeta'), 'Filing unavailable.');
		return;
	}
	setLists(result.report?.folders ?? [], result.report?.owners ?? [], currentDraft.active);
	text(byId('listMeta'), `${result.report?.folders?.length ?? 0} folders, ${result.report?.owners?.length ?? 0} owners`);
	clear('filingRows');
	for (const folder of result.report?.folders ?? []) appendRows('filingRows', [{ title: folder, meta: 'folder' }]);
	for (const owner of result.report?.owners ?? []) appendRows('filingRows', [{ title: owner, meta: 'owner' }]);
	appendRows('filingRows', [{ title: result.report?.shared_owner ?? 'Shared', meta: 'shared owner' }]);
}

function renderDryRun(result) {
	if (!result?.ok) return;
	const counts = result.report?.counts ?? {};
	const moves = (counts.would_copy ?? 0) + (counts.would_move ?? 0);
	setNotice(moves > 0 ? {
		pill: `${moves} document(s) would move`,
		text: 'A re-sort is available after the filing lists change.',
		note: 'Nothing moves before you see the preview.',
		ask: true,
	} : null);
	if (moves > 0 && result.report?.items) {
		for (const item of result.report.items.slice(0, 20)) {
			appendRows('moveRows', [{ title: item.from, meta: item.to ?? 'unsorted', preview: item.to ?? 'unsorted' }]);
		}
	}
}

function askNow() {
	const q = byId('askInput').value.trim() || 'What is the next deadline?';
	void api?.documents().then(renderDocuments);
	void api?.ask(q).then(renderAsk);
}

function filingNow() {
	void api?.filing?.().then(renderFilingShow);
	void api?.dryRun?.().then(renderDryRun);
}

byId('askView').addEventListener('click', () => {
	showView('ask');
	askNow();
});

byId('filingView').addEventListener('click', () => {
	showView('filing');
	filingNow();
});

byId('askButton').addEventListener('click', askNow);

byId('nameInput').addEventListener('input', () => {
	if (currentDraft.active === 'folders') {
		clear('pathTokens');
		appendPath([
			{ cap: '', val: 'library' },
			{ cap: 'folder', val: byId('nameInput').value || 'Finance', active: true },
			{ cap: 'owner', val: 'Ava Lin' },
			{ cap: 'year', val: '2025' },
			{ cap: 'date, matter and title', val: 'invoice-deadlines.pdf' },
		]);
	}
});

byId('saveButton').addEventListener('click', () => {
	const draft = {
		folders: [...currentDraft.folders],
		owners: [...currentDraft.owners],
	};
	void api?.saveFiling?.(draft, true).then((result) => {
		if (!result?.ok || result.report?.ok) {
			text(byId('formHelper'), result?.report?.ok ? 'Draft is valid.' : 'Save unavailable.');
			byId('formHelper').classList.remove('isError');
			return;
		}
		const first = result.report?.errors?.[0];
		text(byId('formHelper'), `${first?.list ?? 'draft'} ${first?.message ?? 'invalid'}`);
		byId('formHelper').classList.add('isError');
	});
});

byId('removeButton').addEventListener('click', () => {
	text(byId('formHelper'), 'Removing does not delete documents. They are re-sorted after a preview.');
});

const hash = (window.location.hash || '').replace(/^#/, '');
const stateMatch = /^demo-(ask|filing)-(.+)$/.exec(hash);
if (stateMatch !== null) {
	applyDemoState(stateMatch[1], stateMatch[2]);
	showView(stateMatch[1]);
} else {
	applyDemoState('ask', 'ask');
	applyDemoState('filing', 'folders');
	showView('ask');
	if (!hash.startsWith('demo-')) {
		filingNow();
		askNow();
	}
}
