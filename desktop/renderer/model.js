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
    preview: [doc.title ?? 'no title yet', doc.owner].filter(Boolean).join(' · '),
    time: monthOf(doc.date),
    cited: isCited(doc, sources),
  }));
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
    if (!seen.has(s.source)) seen.set(s.source, s.chunk);
  }
  return [...seen.entries()].map(([source, chunk], i) => `[${i + 1}] ${basename(source)}, chunk ${chunk}`);
}

export function answerLabel(sources) {
  const n = new Set(sources.map((s) => s.source)).size;
  return n === 1 ? 'answer from 1 document' : `answer from ${n} documents`;
}

export const NO_ANSWER = 'Nothing in your documents matches that question. Try other words, or check that the documents are ingested.';

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

/** The stored name a listed name still has on documents: a rename keeps the old one until re-classified. */
function storedName(changes, list, name) {
  let current = name;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.list === list && c.kind === 'rename' && c.to === current) current = c.from;
  }
  return current;
}

export function filingRows(view, saved, documents, changes, selected) {
  const list = view === 'folders' ? saved.folders : saved.owners;
  const key = view === 'folders' ? 'folder' : 'owner';
  const counts = countBy(documents, key);
  // Counts are what the documents say today. A renamed folder starts at 0: its documents keep the
  // old name (and file under unsorted / the shared owner) until the model re-reads them.
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
  const stored = focus.original === null ? null : storedName(changes, view, focus.original);
  const doc = exampleDoc(documents, key, stored);
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

/** The lists to send to `filing save` for one edit. `shared_owner` is never part of a draft. */
export function draftFor(saved, view, op) {
  const folders = [...saved.folders];
  const owners = [...saved.owners];
  const list = view === 'folders' ? folders : owners;
  if (op.kind === 'rename') list[op.index] = op.name.trim();
  else if (op.kind === 'add') list.push(op.name.trim());
  else if (op.kind === 'remove') list.splice(op.index, 1);
  return { folders, owners };
}

/** Where in the edited list the changed name sits, to match the engine's `{list, index}` errors. */
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
    if (c.kind === 'add') return `added the ${listWord(c.list)} ${c.name}`;
    return `removed the ${listWord(c.list)} ${c.name}`;
  });
  if (parts.length === 0) return '';
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `You ${joined}.`;
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
