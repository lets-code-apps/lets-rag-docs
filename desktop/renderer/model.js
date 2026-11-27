// Pure view logic for the two screens: engine reports + what the user typed in, to the strings,
// rows and states the page prints. No DOM, no IPC, so `node --test` imports this file as is.
// Every value shown comes from an engine report or from the user; nothing here invents data.

export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function docsLabel(n) {
  return n === 1 ? '1 document' : `${n} documents`;
}

/** "1 page", "n pages"; unknown (null) or zero prints nothing. */
export function pagesLabel(n) {
  if (!n) return '';
  return n === 1 ? '1 page' : `${n} pages`;
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
    preview: [doc.title ?? 'no title yet', doc.owner, pagesLabel(doc.pages), formatBytes(doc.bytes)].filter(Boolean).join(' · '),
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

// ---- overview and sidebar ----

/** "1 file", "n files" for counts the sentence needs as a noun. */
export function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** The Shared row's number: documents whose owner is null, the shared owner itself, or a name
 * not on the owners list. `app.js`'s Shared form and the overview "no known owner" item both
 * count with this one rule, so the two can never disagree. */
export function sharedOwnerCount(saved, documents) {
  if (!saved || !documents) return 0;
  return documents.filter((doc) => doc.owner === null || doc.owner === saved.shared_owner || !saved.owners.includes(doc.owner)).length;
}

/** The design's `last sync` figure: "9 mar, 09:24" in the viewer's time zone; `never` for null
 * (the library has not been ingested yet). The engine's value is RFC 3339 UTC. */
export function syncLabel(lastSync) {
  if (!lastSync) return 'never';
  const date = new Date(lastSync);
  if (Number.isNaN(date.getTime())) return 'never';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${hh}:${mm}`;
}

/** The sidebar rows in the design's order, overview first. `graph` is deliberately absent (LET-139
 * is not in this app yet). The count pill shows only on overview and only above 0; the aria label
 * says what the number counts so a screen reader hears "overview, 5 need you". */
export function sidebarItems(section, count) {
  const rows = [
    { section: 'overview', glyph: 'inbox', title: 'overview' },
    { section: 'ask', glyph: 'search', title: 'ask' },
    { section: 'filing', glyph: 'archive', title: 'filing' },
    { section: 'settings', glyph: 'settings', title: 'settings' },
  ];
  const hasCount = section !== null && count > 0;
  return rows.map((row) => ({
    ...row,
    current: row.section === section,
    count: row.section === 'overview' && hasCount ? String(count) : '',
    aria: row.section === 'overview' && hasCount ? `${row.title}, ${count} need you` : row.title,
  }));
}

/** The four figures, as the design shows them: a plain value or a StatusPill for the model. A
 * failed `status` call is honest `unknown`, never a fake `unreachable`. */
export function overviewFigures(docs, status) {
  const documents = docs?.documents ?? null;
  const indexed = documents === null ? null : documents.filter((doc) => doc.skipped === null).length;
  const modelValue = status === null ? 'unknown' : status.model.reachable ? 'connected' : 'unreachable';
  const modelTone = status === null ? 'neutral' : status.model.reachable ? 'positive' : 'danger';
  return [
    { label: 'documents', value: documents === null ? 'unknown' : documents.length.toLocaleString('en-US'), isPill: false },
    { label: 'indexed', value: indexed === null ? 'unknown' : indexed.toLocaleString('en-US'), isPill: false },
    { label: 'last sync', value: syncLabel(status?.last_sync), isPill: false },
    { label: 'model', value: modelValue, isPill: true, tone: modelTone },
  ];
}

/** The "needs you" list, fixed order most blocking first, only kinds the app can actually see.
 * `dry` is the one shared dry-run memo; while it has not landed, item 2 and the count are simply
 * absent, not wrong. Titles and metas follow the design's sentences; only counts are data. */
export function overviewItems(reports) {
  const items = [];
  const { status, docs, saved, dry } = reports;
  if (status && status.model.reachable === false) {
    items.push({
      pill: 'model unreachable', tone: 'danger', glyph: 'settings',
      title: 'The model on this Mac isn’t answering',
      meta: 'Ask and re-sort wait until it’s back. New documents are queued, not lost.',
      action: 'open settings', route: 'settings',
    });
  }
  if (dry && dry.status === 'ok' && moveCount(dry) > 0) {
    const n = moveCount(dry);
    items.push({
      pill: 're-sort waiting', tone: 'attention', glyph: 'arrow-right',
      title: `${copiesLabel(n)} ${plural(n, 'is', 'are')} not where the lists put ${plural(n, 'it', 'them')}`,
      meta: 'Nothing moves until you check the preview in filing.',
      action: 'preview and apply', route: 'preview',
    });
  }
  if (docs && saved) {
    const n = sharedOwnerCount(saved, docs.documents);
    if (n > 0) {
      items.push({
        pill: 'no known owner', tone: 'attention', glyph: 'arrow-right',
        title: `${docsLabel(n)} filed under ${saved.shared_owner}`,
        meta: `The model couldn’t tell whose they are. Pick an owner, or leave them in ${saved.shared_owner}.`,
        action: 'review', route: 'review',
      });
    }
  }
  if (docs) {
    const n = docs.documents.filter((doc) => doc.skipped !== null).length;
    if (n > 0) {
      const over = docs.max_file_mb === null ? 'Ask never uses them.' : `${n} over ${Math.round(docs.max_file_mb)} MB. Ask never uses them.`;
      items.push({
        pill: 'not indexed', tone: 'danger', glyph: 'arrow-right',
        title: `${docsLabel(n)} can’t be searched`,
        meta: over,
        action: 'show documents', route: 'documents',
      });
    }
  }
  if (docs) {
    const n = docs.documents.filter((doc) => doc.dataless).length;
    if (n > 0) {
      items.push({
        pill: 'only in iCloud', tone: 'attention', glyph: 'arrow-up-right',
        title: `${n} ${plural(n, 'file', 'files')} ${plural(n, 'isn’t', 'aren’t')} on this Mac`,
        meta: 'Your library is in iCloud Drive and macOS removed local copies to save space. Set the library folder to keep downloaded in Finder.',
        action: 'show how', route: 'how',
      });
    }
  }
  return items;
}

/** The move report the overview may count as *current*. The filing preview is tagged with the
 * generation that produced it; a new document bumps the generation, so a stale zero-move preview
 * can no longer hide the copy the new document still needs, and the fresh shared memo wins. */
export function overviewDryReport({ preview, previewGeneration, memo, generation }) {
  if (preview && previewGeneration === generation) return preview;
  if (memo && memo.generation === generation) return memo.report ?? null;
  return null;
}

/** "Nothing needs you": every read landed, no library notice is up, and the shared dry-run reported
 * `ok` with nothing to move. A `no_database` or `outdated` report is a library that needs attention
 * — the recovery notice already says what to run — so it is never a false all-clear. */
export function allClear({ docs, docsError, status, saved, notice, dry, items }) {
  if (!docs || docsError || !status || !saved) return false;
  if (notice !== null) return false;
  if (!dry || dry.status !== 'ok') return false;
  return items.length === 0;
}

/** The dry-run memo filing and overview share. Two states the earlier code conflated: a run that is
 * still *pending* must be joined by every caller (one hash pass per library state, however many
 * visits land on the overview), while a run that has *settled as a failure* is not a result to keep,
 * so the next visit retries it.
 *
 * `run` is the engine call and `currentGeneration` reads the app's library generation, which a save,
 * an apply or a new document bumps. `ensure` returns the shared promise, which resolves to the memo —
 * or `null` when the library changed while the pass was hashing. */
export class DryRunMemo {
  constructor(run, currentGeneration) {
    this.run = run;
    this.currentGeneration = currentGeneration;
    this.memo = null; // {generation, pending, report, promise}
    this.error = null;
  }

  /** Reuse while pending or current; start again only after a settled failure. */
  ensure(generation) {
    const memo = this.memo;
    const settledFailure = memo !== null && !memo.pending && memo.report === null;
    if (memo && memo.generation === generation && !settledFailure) return memo.promise;
    const fresh = { generation, pending: true, report: null, promise: null };
    fresh.promise = (async () => {
      const res = await this.run();
      fresh.pending = false;
      if (generation !== this.currentGeneration()) return null; // saved or added while hashing
      if (res && res.ok) {
        fresh.report = res.report;
        this.error = null;
      } else {
        fresh.report = null;
        this.error = res?.error ?? 'The engine did not answer about the moves.';
      }
      return fresh;
    })();
    this.memo = fresh;
    return fresh.promise;
  }

  /** Why the overview is not all-clear when the dry-run is the reason: a settled failure only. */
  failure(generation) {
    const memo = this.memo;
    if (!memo || memo.generation !== generation || memo.pending || memo.report !== null) return null;
    return this.error;
  }

  /** The lists changed (a save, an apply, a new document): the next caller hashes again. */
  invalidate() {
    this.memo = null;
    this.error = null;
  }
}

// ---- first-run onboarding (LET-136) ----
//
// The model-step brain: what `model detect --json` answered becomes the state and the preselected model
// the step shows; the folders-to-watch rows and the four-step list are shaped from `setup show`; and a
// download progress snapshot becomes the design's "2.2 of 5.2 GB · 42%". Every number is the engine's;
// nothing here opens a socket or invents data. The shared thresholds and preselect order are lets-triage
// mail's (PR #26), so both apps recommend and preselect alike.

/** True only when the library path is inside iCloud Drive's `Mobile Documents` mount, where macOS may keep
 * files online-only (the overview's "only in iCloud" item). Checked on the home-relative path the engine
 * reports, so a near-miss folder name (`Mobile Documentsx`) is not iCloud. */
export function isICloudPath(path) {
  return String(path).startsWith('~/Library/Mobile Documents/');
}

/** Recommended model by the Mac's memory — the SAME thresholds lets-triage mail uses, so both apps
 * suggest the same size for the same machine (smoke and shots fix the machine at 16 GiB). */
const GB = 1024 ** 3;
export function recommendedModel(totalBytes) {
  const mem = totalBytes / GB;
  if (mem < 12) return { model: 'qwen3:4b', sizeGb: 2.5 };
  if (mem < 32) return { model: 'qwen3:8b', sizeGb: 5.2 };
  return { model: 'qwen3:14b', sizeGb: 9.3 };
}

/** The download bar's text for one progress snapshot. GB are the engine's own byte numbers (already
 * one decimal, as `pullProgress` produces), and the percent is the engine's completed/total, never a guess. */
export function formatProgress(done, total, pct) {
  const r1 = (x) => Math.round(x * 10) / 10;
  return `${r1(done)} of ${r1(total)} GB · ${pct}%`;
}

/** `setup show` → the folders-to-watch rows (step 2). Pre-fill is the recommendations until the user has
 * actually written the list, after which it is exactly what they wrote. A row is "watched" only once the
 * list was set — watching the folders is a follow-up task, so the step carries the muted note, not a claim. */
export function watchRows(show) {
  const set = show.watch_folders_set === true;
  const list = set ? (show.watch_folders ?? []) : (show.recommended_watch_folders ?? []);
  return list.map((path) => ({ path, watched: set }));
}

/** The four design steps in order. The middle one ("folders and owners") is the plan's skipped step:
 * it is present for the aria list but marked skipped, and never a "current" step. `current` is the index
 * the page marks `aria-current="step"`; steps before it are done, after are still to do. */
export function setupSteps(current) {
  const steps = [
    { key: 'library', title: 'library' },
    { key: 'watch', title: 'folders to watch' },
    { key: 'filing', title: 'folders and owners' },
    { key: 'model', title: 'model' },
  ];
  return steps.map((s, i) => {
    const skipped = s.key === 'filing';
    return { ...s, skipped, state: skipped ? 'skipped' : i < current ? 'done' : i === current ? 'current' : 'rest' };
  });
}

/** The runtime word the engine names, said the way the design says it ("Ollama", "LM Studio"). */
export function runtimeName(runtime) {
  const names = { ollama: 'Ollama', lmstudio: 'LM Studio' };
  return names[runtime] ?? 'A model runtime';
}

/** The muted line the board's answer 4 asked for: this app's own `[llm]` keys already pick a model,
 * so the shared setting only takes effect for the other app. One note, shown on the found/shared step
 * when `config.overridden` is true. The "change it later in settings" sentence from the design is
 * dropped (answer 2): no settings model picker exists yet. */
export function sharedNote() {
  return 'Rag docs and triage mail share this setting.';
}

/** The `[llm]`-over-shared note, shown only when `overridden` is true. */
export const OVERRIDDEN_NOTE = 'Your config.toml sets its own model; this setting is saved for the other app.';

/**
 * The model step's view: one state + the engine's data → the exact pill/line/note/rows the page paints
 * (the same shape lets-triage mail's setup-model.ts produces, with rag docs' copy). All strings are
 * fixed design copy or engine-derived data; the page formats nothing. `memGb` is the machine's memory
 * in whole GB as main answers it (a host number, never a guess here); `pull` is the engine's own
 * progress snapshot; `error` is the engine's sentence for a failed download.
 */
export function modelView(state, data) {
  const runtime = runtimeName(data.runtime ?? 'ollama');
  const url = data.url ?? '';
  const memGb = data.memGb ?? 0;
  const rec = data.recommend ?? recommendedModel(memGb * 1024 ** 3);
  const view = { state, pill: '', tone: 'neutral', text: '', note: '', ob: data.overridden === true, bar: null, barModel: '', actions: [], models: [], selected: '', modelNote: '', hasAddress: true, nextLabel: 'start filing', nextOff: false, nextVariant: 'primary' };
  switch (state) {
    case 'detecting':
      return { ...view, pill: 'looking for a runtime', tone: 'neutral', text: 'Checking Ollama at localhost:11434 and LM Studio at localhost:1234.', note: 'The model runs on this Mac, so nothing you give it leaves the computer.', address: '', nextOff: true };
    case 'found': {
      const n = (data.usable ?? []).length;
      return { ...view, pill: `${runtime} found`, tone: 'positive', text: `${runtime} is running at ${url} with ${n} ${n === 1 ? 'model' : 'models'}. Rag docs picked the one that fits this Mac.`, note: sharedNote(), models: data.usable ?? [], selected: data.model ?? '', modelNote: `Recommended for this Mac's ${memGb} GB of memory: ${rec.model}, ${rec.sizeGb} GB.` };
    }
    case 'found-empty':
      return { ...view, pill: `${runtime} found`, tone: 'attention', text: `${runtime} is running at ${url}, with no model rag docs can use yet.`, note: `Downloading ${rec.model} (${rec.sizeGb} GB) fits this Mac's ${memGb} GB of memory.`, actions: [{ label: `download ${rec.model}`, variant: 'primary', glyph: 'arrow-down' }], nextOff: true };
    case 'not-found':
      return { ...view, pill: 'no runtime found', tone: 'attention', text: 'Rag docs needs a model runtime on this Mac. Ollama is free and runs models locally, so nothing leaves the computer.', note: `Install Ollama and open it. This step finds it by itself, then downloads ${rec.model} (${rec.sizeGb} GB), the right size for this Mac's ${memGb} GB of memory.`, actions: [{ label: 'install Ollama', variant: 'primary', glyph: 'arrow-up-right' }, { label: 'check again', variant: 'secondary', glyph: '' }], nextLabel: 'set up later', nextVariant: 'secondary' };
    case 'downloading': {
      const pull = data.pull ?? { model: rec.model, done: 0, gb: 0, pct: 0 };
      return { ...view, pill: 'downloading model', tone: 'neutral', text: `${runtime} is running. Rag docs is downloading ${pull.model} through it.`, note: 'You can go on. The download keeps going, and rag docs starts when it is done.', bar: formatProgress(pull.done, pull.gb, pull.pct), barModel: pull.model, actions: [{ label: 'cancel download', variant: 'ghost', glyph: '' }] };
    }
    case 'ready':
      return { ...view, pill: 'ready', tone: 'positive', text: `${data.model} runs in ${runtime} on this Mac and answered a test question.`, note: sharedNote() };
    case 'shared':
      return { ...view, pill: 'using the model from triage mail', tone: 'positive', text: `${data.model} in ${runtime} at ${url}, set up when you installed triage mail.`, note: sharedNote(), hasAddress: false, actions: [{ label: 'use another model', variant: 'secondary', glyph: '' }] };
    default:
      return { ...view, pill: 'download failed', tone: 'danger', text: data.error ?? 'The download stopped before the model was complete.', note: '', actions: [{ label: 'try again', variant: 'primary', glyph: '' }], nextLabel: 'set up later', nextVariant: 'secondary' };
  }
}

/** The four steps' titles and opening lines, the design's copy (the step content below is built from
 * engine reports). `watchNote` is the board's answer 1: the screen must not promise watching that
 * does not happen yet, so this exact muted line sits under the folder list. */
export const SETUP_COPY = {
  library: { title: 'library location', text: 'Rag docs keeps a filed copy of each document here. Your originals stay where they are.' },
  watch: { title: 'folders to watch', text: 'New documents in these folders are copied to the library and filed. Turn off any you don’t want read.' },
  filing: { title: 'folders and owners', text: 'Each copy is filed by folder, then by owner. The default folders fit most homes.' },
  model: { title: 'model', text: 'Rag docs reads and files your documents with a model that runs on this Mac.' },
  watchMuted: 'Rag docs never reads its own library, even inside a watched folder. Your originals are never moved or changed.',
  watchLater: 'Rag docs starts watching these folders in a later update.',
  ownersMuted: 'No owners yet is fine. Every copy is filed under Shared until you add some.',
};

/**
 * `model detect --json` → the model step. The rules are the board's and the design's, and read the engine
 * report without deciding anything the engine has not already decided:
 *  - a complete shared block that is reachable AND was set by "triage mail" wins as `shared` (the other
 *    app already chose the model; this app just follows it).
 *  - else the first reachable runtime with a usable model is `found`. Preselect order: this app's own
 *    `config.model` when usable, else the memory `recommendedModel` when usable, else the first usable id
 *    (the engine already keeps embeddings out of `usable`).
 *  - else a reachable runtime with no usable model is `found-empty`: the step offers a download of the
 *    recommendation (the design's open proposal, kept — no auto-download).
 *  - else nothing is reachable: `not-found` (the step re-checks itself every 3 s while it stays there).
 * `overridden` is the one muted note that config.toml sets its own model; `recommend` is what a download
 * would fetch on this machine.
 */
export function stepFromDetect(detect, memBytes) {
  const rec = recommendedModel(memBytes);
  const overridden = detect.config?.overridden === true;
  const runtimes = detect.runtimes ?? [];
  const reachable = runtimes.filter((r) => r.reachable);
  const has = (id) => reachable.some((r) => (r.usable ?? []).includes(id));

  const shared = detect.shared;
  if (shared && shared.reachable && shared.set_by === 'triage mail') {
    return { state: 'shared', model: shared.model, runtime: shared.runtime, url: shared.url, overridden, recommend: rec };
  }
  const withUsable = reachable.find((r) => (r.usable ?? []).length > 0);
  if (withUsable) {
    const cfgModel = detect.config?.model ?? '';
    const chosen = has(cfgModel) ? cfgModel : has(rec.model) ? rec.model : withUsable.usable[0];
    const source = reachable.find((r) => (r.usable ?? []).includes(chosen));
    return { state: 'found', model: chosen, runtime: source.runtime, url: source.url, overridden, recommend: rec };
  }
  const empty = reachable.find((r) => (r.usable ?? []).length === 0);
  if (empty) {
    return { state: 'found-empty', model: null, runtime: empty.runtime, url: empty.url, overridden, recommend: rec };
  }
  return { state: 'not-found', model: null, runtime: null, url: null, overridden, recommend: rec };
}



