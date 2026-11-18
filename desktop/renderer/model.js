// Pure view logic for the two screens: engine reports + what the user typed in, to the strings,
// rows and states the page prints. No DOM, no IPC, so `node --test` imports this file as is.
// Every value shown comes from an engine report or from the user; nothing here invents data.

export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function docsLabel(n) {
  return n === 1 ? '1 document' : `${n} documents`;
}

export function basename(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1];
}

function dirname(path) {
  const parts = String(path).split('/');
  return parts.slice(0, -1);
}

/** A path without any extensions: how the engine names a cited document (`Passage.source`). */
export function withoutExtensions(path) {
  const dir = dirname(path);
  const base = basename(path);
  const dot = base.indexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return [...dir, stem].join('/');
}

/** The ListRow avatar for a document: its file type, as the design shows "PDF" or "MD". */
export function fileType(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '?';
  return base.slice(dot + 1).slice(0, 4).toUpperCase();
}

/** The ListRow avatar for a name: first letters of two words, or the first two letters. */
export function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name).slice(0, 2).toUpperCase() || '?';
}

/** The design's byte size: decimal units, one decimal only under 10. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 ? String(Math.round(value)) : (value < 10 ? value.toFixed(1) : String(Math.round(value)));
  return `${shown} ${units[unit]}`;
}

export function monthOf(date) {
  const m = /^\d{4}-(\d{2})/.exec(date ?? '');
  if (!m) return '';
  return MONTHS[Number(m[1]) - 1] ?? '';
}

// ---- ask ----

/** True when a cited passage comes from this document. */
export function isCited(doc, sources) {
  return sources.some((s) => s.source === withoutExtensions(doc.path) || s.file.startsWith(`${doc.path}.`));
}

export function libraryRows(documents, sources = []) {
  return documents.map((doc) => ({
    key: doc.path,
    initials: fileType(doc.path),
    title: basename(doc.path),
    // The design's row meta: title, owner, pages and the size that made it skippable.
    preview: [doc.title ?? 'no title yet', doc.owner, doc.pages ? `${doc.pages} pages` : '', formatBytes(doc.bytes)].filter(Boolean).join(' · '),
    time: monthOf(doc.date),
    cited: isCited(doc, sources),
    overLimit: doc.skipped === 'over_limit',
  }));
}

export function overLimitLabel(maxFileMb) {
  return maxFileMb === null || maxFileMb === undefined ? 'not indexed' : `not indexed: over ${Math.round(maxFileMb)} MB`;
}

export function libraryMeta(report) {
  if (report === null) return '';
  if (report.status === 'no_database') return 'no library yet';
  if (report.status === 'outdated') return 'library needs ingest';
  return docsLabel(report.documents.length);
}

export function libraryNotice(report) {
  if (report.status === 'no_database') return 'No library yet. Run “lets-rag-docs ingest” on this Mac, then reopen this window.';
  if (report.status === 'outdated') return 'The library was built by an older version. Run “lets-rag-docs ingest” to bring it up to date.';
  if (report.documents.length === 0) return 'The library is empty. Add documents and run “lets-rag-docs ingest”.';
  return null;
}

/** One pill per cited document, numbered in the order the engine ranked them. */
export function citations(sources) {
  const seen = new Map();
  for (const s of sources) {
    if (!seen.has(s.source)) seen.set(s.source, s);
  }
  // The design cites the page within the document when the OCR text carries markers; old
  // documents without markers keep the chunk number.
  return [...seen.values()].map((s, i) => `[${i + 1}] ${basename(withoutExtensions(s.source))}${s.page !== null && s.page !== undefined ? `, p. ${s.page}` : `, chunk ${s.chunk}`}`);
}

/** The documents to offer under the answer: distinct cited ones that are in the library, ranked
 * order, at most 3. The page opens them by their library path — the engine resolves the file. */
export function openTargets(documents, sources) {
  const bySource = new Map();
  for (const s of sources) {
    if (!bySource.has(s.source)) bySource.set(s.source, s);
  }
  const targets = [];
  for (const s of bySource.values()) {
    const doc = documents.find((d) => isCited(d, [s]));
    if (doc) targets.push({ path: doc.path, label: `open ${basename(withoutExtensions(doc.path))}` });
    if (targets.length === 3) break;
  }
  return targets;
}

export function answerLabel(sources) {
  const n = new Set(sources.map((s) => s.source)).size;
  return n === 1 ? 'answer from 1 document' : `answer from ${n} documents`;
}

export const NO_ANSWER = 'Nothing in your documents matches that question. Try other words, or check that the documents are ingested.';

// ---- add progress ----

/** One listRow per picked file: waiting -> adding… -> added (type) / already added / failed. */
export function addRows(picked, results) {
  return picked.map((name, i) => {
    const r = results[i];
    if (r === undefined || r.state === 'waiting') return { key: name, title: name, initials: fileType(name), preview: 'waiting', pill: '', tone: 'neutral' };
    if (r.state === 'adding') return { key: name, title: name, initials: fileType(name), preview: 'adding…', pill: '', tone: 'attention' };
    if (r.state === 'added') return { key: name, title: name, initials: fileType(name), preview: `added (${r.type})`, pill: '', tone: 'positive' };
    if (r.state === 'duplicate') return { key: name, title: name, initials: fileType(name), preview: 'already added', pill: '', tone: 'neutral' };
    if (r.state === 'cancelled') return { key: name, title: name, initials: fileType(name), preview: 'cancelled', pill: '', tone: 'neutral' };
    return { key: name, title: name, initials: fileType(name), preview: `failed: ${r.error}`, pill: '', tone: 'danger' };
  });
}

/** "2 of 3" while adding, "cancelled" after a cancel, "done" when the last row finished. */
export function addMeta(results, cancelled) {
  if (cancelled) return 'cancelled';
  if (results.length === 0) return '';
  const done = results.filter((r) => r.state !== 'adding' && r.state !== 'waiting').length;
  return done === results.length ? 'done' : `${done} of ${results.length}`;
}

// ---- filing ----

export function countBy(documents, key) {
  const counts = new Map();
  for (const doc of documents) {
    const value = doc[key];
    if (value === null || value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** What changed in this session, newest last: renames show "was …", additions "new". */
export function rowPill(changes, list, name) {
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.list !== list) continue;
    if (c.kind === 'rename' && c.to === name) return `was ${c.from}`;
    if (c.kind === 'add' && c.name === name) return 'new';
  }
  return '';
}

export function filingRows(view, saved, documents, changes, selected) {
  const list = view === 'folders' ? saved.folders : saved.owners;
  const key = view === 'folders' ? 'folder' : 'owner';
  const counts = countBy(documents, key);
  // Counts are what the documents say today; after a save the engine has already re-filed the
  // renamed rows, so a rename shows its documents right away.
  const listed = new Set(list);
  const rows = list.map((name, index) => ({
    kind: 'item',
    index,
    title: name,
    initials: initials(name),
    time: docsLabel(counts.get(name) ?? 0),
    preview: '',
    pill: rowPill(changes, view, name),
    selected: selected?.kind === 'item' && selected.index === index,
  }));
  const rest = documents.filter((doc) => !listed.has(doc[key]) || doc[key] === null).length;
  if (view === 'folders') {
    rows.push({ kind: 'unsorted', title: 'unsorted', initials: '?', time: docsLabel(rest), preview: 'Documents that fit no folder.', pill: '', selected: false });
  } else {
    rows.push({
      kind: 'shared',
      title: saved.shared_owner,
      initials: initials(saved.shared_owner),
      time: docsLabel(rest),
      preview: 'Nobody on the list, or several people.',
      pill: 'shared owner',
      selected: selected?.kind === 'shared',
    });
  }
  return rows;
}

export function listMeta(view, saved, total) {
  if (view === 'folders') {
    const n = saved.folders.length;
    return `${docsLabel(total)} in ${n === 1 ? '1 folder' : `${n} folders`}`;
  }
  const n = saved.owners.length;
  return `${docsLabel(total)}, ${n === 0 ? 'no owners' : n === 1 ? '1 owner' : `${n} owners`}`;
}

export const FOLDER_NOTE = 'The model on this Mac picks one folder per document, from this list only.';
export const OWNER_NOTE = 'An owner is whose document it is: a family member or one of your own companies.';
export const RESORT_NOTE = 'Saving changes the lists only. Documents are re-sorted when you ask, and nothing moves before you see the preview.';

/** A filed copy from the library to base the example on: one under the focused name if there is one. */
function exampleDoc(documents, key, stored) {
  const filed = documents.filter((doc) => doc.filed_as !== null && doc.filed_as.split('/').length === 4);
  return filed.find((doc) => stored !== null && doc[key] === stored) ?? filed[0] ?? null;
}

/**
 * The "where a copy goes" example: library / folder / owner / year / file. The level this view
 * edits is highlighted and follows the name field as the user types. With no filed copy yet the
 * example says what each level is instead of inventing a document.
 */
export function examplePath(view, saved, documents, changes, focus) {
  const key = view === 'folders' ? 'folder' : 'owner';
  const doc = exampleDoc(documents, key, focus.original);
  const [folder, owner, year, file] = doc
    ? doc.filed_as.split('/')
    : [saved.folders[0] ?? 'Other', saved.shared_owner, String(new Date().getFullYear()), 'date, matter - title.pdf'];
  const live = focus.value.trim() || focus.placeholder || focus.original || '';
  const levels = [
    ['', 'library'],
    ['folder', view === 'folders' && live ? live : folder],
    ['owner', view === 'owners' && live ? live : owner],
    ['year', year],
    ['date, matter and title', file],
  ];
  return levels.map(([cap, val], i) => ({ cap: cap || ' ', val, on: cap === (view === 'folders' ? 'folder' : 'owner'), sep: i < levels.length - 1 ? ' /' : '' }));
}

/**
 * The lists to send to `filing save` for one edit. A rename also carries `renames` so the engine
 * re-files the stored copies (and updates the DB rows) instead of stranding them; editing the
 * shared owner sends `shared_owner`. The save report comes back with the applied lists.
 */
export function draftFor(saved, view, op) {
  const folders = [...saved.folders];
  const owners = [...saved.owners];
  const draft = { folders, owners };
  if (op.kind === 'rename') {
    const list = view === 'folders' ? folders : owners;
    const from = list[op.index];
    list[op.index] = op.name.trim();
    draft.renames = [{ list: view, from, to: op.name.trim() }];
  } else if (op.kind === 'add') {
    (view === 'folders' ? folders : owners).push(op.name.trim());
  } else if (op.kind === 'remove') {
    (view === 'folders' ? folders : owners).splice(op.index, 1);
  } else if (op.kind === 'shared') {
    draft.shared_owner = op.name.trim();
  }
  return draft;
}

/** Where in the edited list the changed name sits, to match the engine's `{list, index}` errors.
 * The shared owner reports `list: "shared_owner"` with no index, so null matches it. */
export function editedIndex(saved, view, op) {
  if (op.kind === 'rename') return op.index;
  if (op.kind === 'add') return (view === 'folders' ? saved.folders : saved.owners).length;
  return null;
}

/** The engine's validation issue, said the way the design says it (same rule, plainer words). */
export function friendlyError(issue, sharedOwner) {
  const name = issue.name ?? '';
  if (issue.code === 'empty_list') return 'Keep at least one folder: every document needs somewhere to go.';
  if (issue.code === 'duplicate') return 'That name is already on the list.';
  if (issue.code === 'invalid_name') {
    if (issue.list === 'owners' && name.toLowerCase() === sharedOwner.toLowerCase()) {
      return `${sharedOwner} is the shared owner already. Pick another name.`;
    }
    const bad = [...new Set([...name].filter((c) => !/[\p{L}\p{N} \-_.']/u.test(c)))];
    if (bad.length > 0) {
      const shown = bad.map((c) => `"${c}"`).join(' and ');
      return `Take out the ${shown}. The name becomes a folder, so it can’t contain "/" or start or end with a dot.`;
    }
    if (name.trim() === '') return 'Type a name first.';
    if ([...name].length > 60) return 'Keep the name to 60 characters or fewer.';
    return 'The name becomes a folder, so it can’t start or end with a dot or contain "..".';
  }
  return issue.message;
}

function listWord(list) {
  return list === 'folders' ? 'folder' : 'owner';
}

/** One sentence for the "re-sort needed" card, from this session's saved changes. */
export function changeSummary(changes) {
  const parts = changes.map((c) => {
    if (c.kind === 'rename') return `renamed ${c.from} to ${c.to}`;
    if (c.kind === 'shared') return `set the shared owner to ${c.name}`;
    if (c.kind === 'add') return `added the ${listWord(c.list)} ${c.name}`;
    return `removed the ${listWord(c.list)} ${c.name}`;
  });
  if (parts.length === 0) return '';
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `You ${joined}.`;
}

/** One sentence about what a re-sort does with this session's changes. Renames re-file: the
 * engine moved the stored copies when the lists were saved. Only removals need the old warning. */
export function resortNote(changes) {
  const renames = changes.some((c) => c.kind === 'rename');
  const removals = changes.some((c) => c.kind === 'remove');
  if (renames && removals) return 'Documents keep a renamed name, so re-sorting moves their copies to the new folder; removing a folder sends its documents to unsorted (or the shared owner) until “lets-rag-docs classify --force”.';
  if (renames) return 'Documents keep a renamed name, so re-sorting moves their copies to the new folder.';
  if (removals) return 'Documents of a removed folder go to unsorted (or the shared owner) until `classify --force` gives them a new folder.';
  return '';
}

export function moveCount(report) {
  return (report.counts.would_copy ?? 0) + (report.counts.would_move ?? 0);
}

function chain(path) {
  return dirname(path).join(' / ');
}

/** The dry-run as the design's "what will move" rows: only copies that will be made or moved. */
export function movePlan(report) {
  const rows = report.items
    .filter((item) => (item.action === 'copy' || item.action === 'move') && item.to !== null)
    .map((item) => ({
      title: basename(item.to),
      to: `to ${chain(item.to)}`,
      from: item.action === 'move' ? `from ${chain(item.from)}` : `first copy of ${basename(item.from)}`,
      pill: item.action === 'copy' ? 'new copy' : '',
    }));
  return { count: moveCount(report), rows };
}

export function copiesLabel(n) {
  return n === 1 ? '1 copy' : `${n} copies`;
}

export function dryRunProblem(report) {
  if (report.status === 'no_database') return 'There is no library yet, so nothing can be re-sorted. Run “lets-rag-docs ingest” first.';
  if (report.status === 'outdated') return 'The library was built by an older version. Run “lets-rag-docs ingest” before re-sorting.';
  if (report.status !== 'ok') return `The engine reported "${report.status}". Nothing was changed.`;
  return null;
}

export function applySummary(report) {
  const c = report.counts;
  const done = [];
  if (c.moved) done.push(`moved ${copiesLabel(c.moved)}`);
  if (c.copied) done.push(`made ${copiesLabel(c.copied)}`);
  const head = done.length > 0 ? `Done: ${done.join(' and ')}.` : 'Nothing needed to move.';
  return c.failed ? `${head} ${copiesLabel(c.failed)} could not be filed; run “lets-rag-docs organize --dry-run” to see why.` : head;
}
