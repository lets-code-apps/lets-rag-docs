// The RAG Docs window. Every value on screen comes from an engine report (through the preload's
// `window.ragDocs`) or from what the user typed: no canned or made-up content. The page never
// builds argv: it sends a question, a draft of the two lists, or nothing. Engine text is written
// with textContent only.

import * as m from './model.js';
import * as sidebar from './sidebar.js';

const api = window.ragDocs;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW_ROWS = 3;
const ALL_ROWS = 200;

const state = {
  section: 'overview',
  docs: null,
  docsError: null,
  libraryFilter: null, // 'not-indexed' while the overview's "show documents" route holds
  overview: { status: null, statusError: null, how: 'closed' }, // 'closed' | 'open' | 'dismissed'
  ask: { question: '', busy: false, report: null, error: null, cancelled: false, copied: false },
  filing: {
    loaded: false,
    saved: null,
    error: null,
    view: 'folders',
    selected: null, // {kind:'item', index} | {kind:'shared'} | {kind:'add'} | null (notice shown)
    touched: false,
    value: '',
    fieldError: null,
    saving: false,
    changes: [], // saved this session: {kind, list, from/to | name}
    notice: null, // null | 'ask' | 'running' | 'preview' | 'applying' | 'done'
    pendingText: null, // a re-sort the engine reported on opening, before any change here
    dry: null,
    dryGeneration: -1, // which saveGeneration produced the preview: an add makes it stale
    showAll: false,
    applied: null,
  },
  search: { query: '', seq: 0, hits: null, error: null },
  add: { picked: [], results: [], running: false, cancelled: false },
  open: { error: null },
  settings: { appearance: 'system', openAtLogin: false, memGb: 0 },
  // First-run onboarding (LET-136): step choices live only in here until the last continue sends
  // them to main (modelSetup), which performs every write in one fixed order and records setupDone.
  onboarding: {
    active: false,
    step: 0, // 0 library, 1 watch, 2 filing (drawn skipped in the step list), 3 model
    show: null, // `setup show` report
    libPath: '',
    recommended: '',
    watch: [], // [{path, on}]
    owners: [], // added this session; only these travel to `filing save`
    filing: null, // `filing show` report for the folders block
    typedOwner: '',
    detect: null, // last `model detect` report
    stepModel: null, // m.stepFromDetect result for the current detect
    viewState: 'detecting', // detecting|found|found-empty|not-found|downloading|ready|failed|shared
    models: [], // usable ids of the chosen runtime (the model segmented control)
    chosenModel: '', // a model the user picked in the segmented control
    pull: null, // {model, done, gb, pct} while a download runs; engine's own numbers
    pullRunning: false,
    pullError: null, // the engine's sentence for a failed download
    cancelled: false, // the user cancelled the download: re-detect, not a failure
    overrideShared: false, // "use another model" on the shared step: a pick here travels
    address: '', // typed runtime address (only used by a re-check)
    recheck: null, // timer id: not-found re-detects every 3 s
    poll: null, // interval id: reads modelPullStatus (~500 ms), never wrapped in track()
    error: null, // why a continue did not go through
    filingLoaded: false,
    done: false,
  },
};

// ---- small DOM helpers ----

/** In-flight engine calls, so smoke and screenshot runs can wait for a settled page. */
let pending = 0;
async function track(promise) {
  pending += 1;
  document.body.dataset.pending = String(pending);
  try {
    return await promise;
  } finally {
    pending -= 1;
    document.body.dataset.pending = String(pending);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, px) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const TONES = new Set(['neutral', 'positive', 'attention', 'danger']);
function setPill(node, label, tone) {
  node.className = `pill ${TONES.has(tone) ? tone : 'neutral'}`;
  node.replaceChildren(el('span', '', label));
}

function pill(label, tone) {
  const node = el('span');
  setPill(node, label, tone);
  return node;
}

/** The design's ListRow. A button when it can be picked, a plain row otherwise. */
function listRow(row, onPick) {
  const node = el(onPick ? 'button' : 'div', 'row');
  if (onPick) {
    node.type = 'button';
    node.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
    node.addEventListener('click', onPick);
  } else if (row.selected) {
    node.classList.add('selected');
  }
  node.append(el('span', 'avatar', row.initials));
  const text = el('span', 'row-text');
  const line = el('span', 'row-line');
  line.append(el('span', 'row-title', row.title));
  if (row.time) line.append(el('span', 'row-time', row.time));
  text.append(line);
  if (row.subject) text.append(el('span', 'row-subject', row.subject));
  if (row.preview) text.append(el('span', 'row-preview', row.preview));
  if (row.pill) text.append(pill(row.pill, row.tone ?? 'neutral'));
  node.append(text);
  node.title = row.title;
  return node;
}

// ---- navigation ----

function render() {
  if (state.onboarding.active) {
    // Onboarding replaces the sidebar and every screen (LET-136); the four screens stay hidden
    // until the last continue records setupDone.
    renderOnboarding();
    $('sidebar').hidden = true;
    $('onboardingScreen').hidden = false;
    $('overviewScreen').hidden = true;
    $('askScreen').hidden = true;
    $('filingScreen').hidden = true;
    $('settingsScreen').hidden = true;
    return;
  }
  renderOverview();
  // The sidebar is one shared component (design Sidebar.dc.html): paint moves the current row
  // and shows the overview count. It counts what a render can currently see pending; the dry-run
  // item appears when the memo lands, then a render raises the count.
  sidebar.paint($('sidebar'), state.section, paintedItems.length);
  $('sidebar').hidden = false;
  $('onboardingScreen').hidden = true;
  $('overviewScreen').hidden = state.section !== 'overview';
  $('askScreen').hidden = state.section !== 'ask';
  $('filingScreen').hidden = state.section !== 'filing';
  $('settingsScreen').hidden = state.section !== 'settings';
  renderAsk();
  renderFiling();
  renderSettings();
}

function showSection(section) {
  state.section = section;
  render();
  if (section === 'overview') {
    // The overview owns the checks behind its rows and its all-clear: re-arm the shared dry-run, and
    // retry the filing lists if their first load failed, so all-clear only appears once every read
    // has succeeded for the current data.
    if (!f().loaded || !f().saved) void loadFilingLists();
    void ensureDryRun().then(() => render());
  }
  if (section === 'filing' && !state.filing.loaded) void loadFilingLists();
  if (section === 'settings') void loadSettings();
}

// ---- overview ----

/** The needs-you items from the last render; the sidebar counts exactly these. */
let paintedItems = [];

async function loadOverview() {
  const res = await track(api.status());
  if (res && res.ok) {
    state.overview.status = res.report;
    state.overview.statusError = null;
  } else {
    // A failed call is `unknown`, never a claim the model is down: one honest error line, no item.
    state.overview.status = null;
    state.overview.statusError = res?.error ?? 'The engine did not answer about the model.';
  }
  render();
}

/** One row of the design's list: a StatusPill naming the kind, title, meta, one secondary button. */
function needRow(item) {
  const row = el('div', 'need-row');
  const text = el('div', 'need-text');
  text.append(pill(item.pill, item.tone));
  text.append(el('span', 'need-title', item.title));
  text.append(el('span', 'need-meta', item.meta));
  row.append(text);
  if (item.route === 'how' && state.overview.how === 'open') {
    // The static "keep downloaded" steps, inline under the row; `got it` dismisses it for the session.
    const howto = el('div', 'howto');
    howto.append(el('p', 'howto-steps', '1. Open Finder. 2. Right-click your library folder. 3. Choose Keep Downloaded.'));
    const got = el('button', 'btn secondary');
    got.type = 'button';
    got.append(el('span', '', 'got it'));
    got.addEventListener('click', () => {
      // `closed` collapses the steps but keeps the row: an unresolved iCloud item is still
      // unresolved, so it stays counted until fresh metadata says the files were downloaded. Clicking
      // "show how" again reopens the steps (dismissed would hide a real problem and desync the count).
      state.overview.how = 'closed';
      render();
    });
    howto.append(got);
    row.append(howto);
  }
  const button = el('button', 'btn secondary');
  button.type = 'button';
  button.append(icon(item.glyph, 18), el('span', '', item.action));
  button.addEventListener('click', () => routeOverview(item.route));
  row.append(button);
  return row;
}

function renderOverview() {
  const o = state.overview;
  const docs = state.docs;
  const dry = m.overviewDryReport({ preview: f().dry, previewGeneration: f().dryGeneration, memo: dryRuns.memo, generation: saveGeneration });
  const items = m.overviewItems({ status: o.status, docs, saved: f().saved, dry });
  paintedItems = items;

  const figures = m.overviewFigures(docs, o.status);
  $('figDocuments').textContent = figures[0].value;
  $('figIndexed').textContent = figures[1].value;
  $('figSync').textContent = figures[2].value;
  setPill($('figModel'), figures[3].value, figures[3].tone);

  const notice = docs ? m.libraryNotice(docs) : null;
  $('overviewNotice').hidden = notice === null;
  $('overviewNotice').textContent = notice ?? '';

  const rows = $('needRows');
  rows.replaceChildren();
  for (const item of items) {
    rows.append(needRow(item));
  }
  const busy = items.length > 0;
  $('needSection').hidden = !busy;
  $('needCount').textContent = busy ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : '';
  // All-clear means every needs-you read landed for the current data AND the shared dry-run reported
  // `ok` with nothing to move. A read that has not run (or failed) never claims the library is tidy,
  // and `m.allClear` keeps the library notice ahead of it, so a missing or outdated database shows
  // only its recovery notice — never a false "nothing needs you".
  $('allClear').hidden = !m.allClear({ docs, docsError: state.docsError, status: o.status, saved: f().saved, notice, dry, items });
  // One honest overview error line for why the clear state is not shown: the model status first,
  // then a failed dry-run, then a failed filing load. Each is retried on the next overview visit.
  const overviewError = o.statusError ?? dryRuns.failure(saveGeneration) ?? (f().loaded && !f().saved ? f().error : null);
  $('statusError').hidden = overviewError === null;
  $('statusError').textContent = overviewError ?? '';
}

/** Each row's button is a route, not an action of its own: the overview only ever shows the
 * person where to go. preview/review wait for the filing lists; nothing here moves a file. */
function routeOverview(route) {
  if (route === 'settings') showSection('settings');
  else if (route === 'documents') {
    // Cancel any search (done or mid-flight) first, so the not-indexed filter is what runs: an
    // old query would otherwise win and show indexed hits instead of the skipped originals.
    cancelSearch();
    state.libraryFilter = 'not-indexed';
    showSection('ask');
  } else if (route === 'how') {
    state.overview.how = 'open';
    render();
  } else if (route === 'review') void routeReview();
  else void routePreviewAndApply();
}

async function routeReview() {
  if (!f().saved) await loadFilingLists();
  if (!f().saved) return;
  f().view = 'owners';
  f().selected = { kind: 'shared' };
  f().value = f().saved.shared_owner;
  f().touched = true;
  showSection('filing');
}

/** The design's "preview and apply": if the one shared dry-run is current, show its preview; no
 * second hash pass. Only when the memo is missing or stale does this call resort(). */
async function routePreviewAndApply() {
  if (!f().saved) await loadFilingLists();
  if (!f().saved) return;
  const memo = await ensureDryRun();
  const report = memo && memo.generation === saveGeneration ? memo.report : null;
  if (report && m.dryRunProblem(report) === null && m.moveCount(report) > 0) {
    f().dry = report;
    f().dryGeneration = saveGeneration;
    f().notice = 'preview';
    f().selected = null;
    f().touched = true; // keeps applyPendingNotice from replacing this preview
    showSection('filing');
  } else {
    void resort();
  }
}

// ---- ask ----

async function loadDocs() {
  const res = await track(api.documents());
  if (res && res.ok) {
    state.docs = res.report;
    state.docsError = null;
  } else {
    state.docsError = res?.error ?? 'The engine did not answer.';
  }
  render();
}

function renderAsk() {
  const a = state.ask;
  const sources = a.report?.sources ?? [];

  // library
  const searching = state.search.query !== '' && state.search.hits !== null;
  const allDocs = state.docs?.documents ?? [];
  let shown = searching ? allDocs.filter((doc) => m.isCited(doc, state.search.hits)) : allDocs;
  // The overview's "show documents" route filters the same library down to the unsearchable rows.
  const filtered = state.libraryFilter === 'not-indexed';
  if (filtered && !searching) shown = allDocs.filter((doc) => doc.skipped !== null);
  if (searching || filtered) {
    $('libraryMeta').textContent = `${shown.length} of ${m.docsLabel(allDocs.length)}`;
  } else {
    $('libraryMeta').textContent = state.docs ? m.libraryMeta(state.docs) : '';
  }
  $('libraryFilterClear').hidden = !filtered;
  const rows = $('libraryRows');
  rows.replaceChildren();
  if (state.docsError) {
    rows.append(el('p', 'empty error', state.docsError));
  } else if (state.search.error) {
    rows.append(el('p', 'empty error', state.search.error));
  } else if (state.docs) {
    const notice = searching ? null : m.libraryNotice(state.docs);
    if (notice) rows.append(el('p', 'empty', notice));
    if (searching && shown.length === 0) rows.append(el('p', 'empty', `no match for “${state.search.query}” in the library.`));
    const maxMb = state.docs.max_file_mb;
    for (const row of m.libraryRows(shown, sources)) {
      const pillText = row.cited ? 'cited' : row.overLimit ? m.overLimitLabel(maxMb) : '';
      rows.append(listRow({
        ...row,
        selected: row.cited,
        pill: pillText,
        tone: row.cited ? 'positive' : row.overLimit ? 'danger' : 'neutral',
      }, null));
    }
  }
  renderAddPanel();

  // conversation
  const asked = a.question !== '';
  $('askHint').hidden = asked;
  $('questionBubble').hidden = !asked;
  $('questionBubble').textContent = a.question;
  $('askBusy').hidden = !a.busy;
  $('askError').hidden = a.error === null;
  $('askError').textContent = a.error ?? '';

  const report = a.report;
  $('answerBlock').hidden = report === null;
  if (report) {
    const has = report.answer !== null;
    $('answerLabel').hidden = !has;
    $('answerLabelText').textContent = has ? m.answerLabel(sources) : '';
    $('answerText').textContent = has ? report.answer : m.NO_ANSWER;
    $('citations').replaceChildren(...m.citations(sources).map((label) => pill(label, 'neutral')));
    // One button per cited document that is in the library (max 3): opening asks main,
    // which resolves the path through the engine. The renderer only names the document.
    const targets = report.answer !== null ? m.openTargets(state.docs?.documents ?? [], sources) : [];
    $('openDocs').replaceChildren(...targets.map((target) => {
      const button = el('button', 'btn secondary');
      button.type = 'button';
      button.append(icon('arrow-up-right', 18), el('span', '', target.label));
      button.addEventListener('click', () => void openDoc(target.path));
      return button;
    }));
    $('copyAnswer').hidden = !has;
    $('copyAnswerLabel').textContent = a.copied ? 'copied' : 'copy answer';
  }
  $('askButton').disabled = a.busy || state.add.running;
  $('openError').hidden = state.open.error === null;
  $('openError').textContent = state.open.error ?? '';
}

function renderAddPanel() {
  const add = state.add;
  const panel = $('addPanel');
  panel.hidden = add.picked.length === 0;
  if (panel.hidden) return;
  $('addMeta').textContent = m.addMeta(add.results, add.cancelled);
  $('addCancel').hidden = !add.running;
  $('addRows').replaceChildren(...m.addRows(add.picked, add.results).map((row) => listRow(row, null)));
}

async function openDoc(path) {
  const res = await track(api.openDocument(path));
  state.open.error = res && res.ok ? null : (res?.error ?? 'Could not open this document.');
  render();
}

async function ask(event) {
  event.preventDefault();
  const question = $('askInput').value.trim();
  if (question === '' || state.ask.busy) return;
  state.ask = { question, busy: true, report: null, error: null, cancelled: false, copied: false };
  render();
  const res = await track(api.ask(question));
  state.ask.busy = false;
  if (res && res.ok) {
    state.ask.report = res.report;
    $('askInput').value = '';
  } else if (state.ask.cancelled) {
    state.ask.error = 'Stopped. Ask again when you are ready.';
  } else {
    state.ask.error = res?.error === 'busy' || res?.error === 'another long job is running'
      ? 'The model is busy with another job. Try again in a moment.'
      : (res?.error ?? 'The engine did not answer.');
  }
  render();
}

let searchTimer = null;

/** Library search: debounce 400 ms, needs 2 characters, and a sequence number so a reply that
 * arrives after a newer query (or a cleared box) is dropped instead of flickering back. */
function onSearchChange() {
  const query = $('librarySearch').value.trim();
  clearTimeout(searchTimer);
  state.search.seq += 1;
  state.search.query = query;
  state.search.hits = null;
  state.search.error = null;
  if (query !== '') state.libraryFilter = null; // typing in the box restores the full library
  if (query.length >= 2) {
    searchTimer = setTimeout(() => {
      void runSearch(query, state.search.seq);
    }, 400);
  }
  render();
}

async function runSearch(query, seq) {
  const res = await track(api.search(query));
  if (seq !== state.search.seq) return; // the box moved on
  if (res && res.ok) {
    state.search.hits = res.report.passages;
    state.search.error = null;
  } else {
    state.search.hits = null;
    state.search.error = res?.error ?? 'Search failed: the engine did not answer.';
  }
  render();
}

/** Cancel an in-flight or completed search so the box is empty and no stale hits survive: bump the
 * sequence (a reply arriving later is dropped), clear query/hits/error, and empty the field. The
 * overview's "show documents" route uses this before applying its not-indexed filter. */
function cancelSearch() {
  clearTimeout(searchTimer);
  state.search.seq += 1;
  state.search.query = '';
  state.search.hits = null;
  state.search.error = null;
  $('librarySearch').value = '';
}

async function cancelAsk() {
  state.ask.cancelled = true;
  await track(api.cancelAsk());
}

async function addDocs() {
  if (state.add.running) return;
  const picked = await track(api.pickFiles());
  if (!picked || !picked.ok || picked.count === 0) return;
  state.add = { picked: picked.names, results: picked.names.map(() => ({ state: 'waiting' })), running: true, cancelled: false };
  render();
  // One add at a time; ask/apply refuse while this runs (the page says so through the same gate).
  while (!state.add.cancelled) {
    const index = state.add.results.findIndex((r) => r.state === 'waiting');
    if (index < 0) break;
    state.add.results[index] = { state: 'adding' };
    render();
    const res = await track(api.addNext());
    const ok = res && res.ok;
    if (!ok) state.add.results[index] = { state: 'failed', error: res?.error ?? 'the engine did not answer' };
    else if (res.outcome === 'duplicate') state.add.results[index] = { state: 'duplicate' };
    else if (res.outcome === 'failed') state.add.results[index] = { state: 'failed', error: res.error ?? 'the engine failed' };
    else {
      state.add.results[index] = { state: 'added', type: res.report?.type ?? 'document' };
      // A new document can change where the filed copies belong: drop the cached move report *and*
      // the filing's preview of it, so the next overview re-checks instead of showing an all-clear
      // (or a stale zero-move preview) that predates this add.
      dryRuns.invalidate();
      f().dry = null;
      f().dryGeneration = -1;
      f().notice = 'ask';
      void loadDocs();
    }
    if (ok && res.done) break;
  }
  state.add.running = false;
  render();
}

async function cancelAdd() {
  if (!state.add.running) return;
  state.add.cancelled = true;
  state.add.results = state.add.results.map((r) => (r.state === 'waiting' || r.state === 'adding' ? { state: 'cancelled' } : r));
  await track(api.cancelAdd());
  render();
}

async function copyAnswer() {
  const answer = state.ask.report?.answer;
  if (!answer) return;
  try {
    await navigator.clipboard.writeText(answer);
    state.ask.copied = true;
    render();
  } catch {
    // The clipboard can refuse while the window is not focused; the answer stays on screen.
  }
}

// ---- filing ----

function f() {
  return state.filing;
}

function currentList() {
  const s = f().saved;
  return f().view === 'folders' ? s.folders : s.owners;
}

function selectDefault() {
  const list = currentList();
  f().selected = list.length > 0 ? { kind: 'item', index: 0 } : { kind: 'add' };
  f().value = list.length > 0 ? list[0] : '';
  f().fieldError = null;
}

/** The filing lists, apart from the dry-run: the overview needs the lists (item 3 and the routes)
 * without paying for a second hash pass, so this half loads on its own. */
async function loadFilingLists() {
  f().loaded = true;
  const res = await track(api.filing());
  if (!res || !res.ok) {
    f().error = res?.error ?? 'The engine did not answer.';
    render();
    return;
  }
  f().saved = res.report;
  f().error = null;
  selectDefault();
  render();
}

/** The re-sort the engine reported on opening, before the user has started editing: now phrased
 * from the one shared dry-run memo instead of a call of its own. */
function applyPendingNotice(memo) {
  const dry = memo?.report;
  if (!dry || dry.status !== 'ok' || m.moveCount(dry) === 0 || f().changes.length > 0) return;
  f().pendingText = `${m.copiesLabel(m.moveCount(dry))} are not where the current lists put them.`;
  if (!f().touched) {
    f().selected = null;
    f().notice = 'ask';
  }
}

function pick(selected, value) {
  f().touched = true;
  f().selected = selected;
  f().value = value;
  f().fieldError = null;
  f().error = null;
  render();
}

function currentOp() {
  const sel = f().selected;
  const name = f().value.trim();
  if (!sel || name === '') return null;
  if (sel.kind === 'item') return name === currentList()[sel.index] ? null : { kind: 'rename', index: sel.index, name };
  if (sel.kind === 'add') return { kind: 'add', name };
  if (sel.kind === 'shared') return name === f().saved.shared_owner ? null : { kind: 'shared', name };
  return null;
}

function changeFor(op) {
  const list = f().view;
  if (op.kind === 'rename') return { kind: 'rename', list, from: currentList()[op.index], to: op.name };
  if (op.kind === 'add') return { kind: 'add', list, name: op.name };
  if (op.kind === 'shared') return { kind: 'shared', list: 'shared_owner', from: f().saved.shared_owner, name: op.name };
  return { kind: 'remove', list, name: currentList()[op.index] };
}

/** Splits the engine's issues: the one about the edited name goes under the field, the rest above. */
function placeIssues(op, issues) {
  const index = m.editedIndex(f().saved, f().view, op);
  // The draft's shared name is the truth the engine just rejected; quote that, not the stored one.
  const draft = m.draftFor(f().saved, f().view, op);
  const shared = draft.shared_owner ?? f().saved.shared_owner;
  const mine = issues.filter((i) => (op.kind === 'shared'
    ? i.list === 'shared_owner'
    : i.list === f().view && i.index === index));
  const rest = issues.filter((i) => !mine.includes(i));
  f().fieldError = mine.length > 0 ? m.friendlyError(mine[0], shared) : null;
  f().error = rest.length > 0 ? rest.map((i) => `${i.list}${i.name ? ` "${i.name}"` : ''}: ${m.friendlyError(i, shared)}`).join(' ') : null;
}

let checkTimer = null;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void check(), 250);
}

/** Live validation with the engine's own rule (`filing save --check` never writes). */
async function check() {
  const op = currentOp();
  if (!op) {
    f().fieldError = null;
    renderFiling();
    return;
  }
  const value = f().value;
  const res = await track(api.saveFiling(m.draftFor(f().saved, f().view, op), true));
  if (f().value !== value) return; // typed on since; a newer check is coming
  if (res && res.ok && !res.report.ok) placeIssues(op, res.report.errors);
  else {
    f().fieldError = null;
    if (res && !res.ok) f().error = res.error ?? null;
  }
  renderFiling();
}

/** Bumped when a save starts: a dry-run that began earlier must not show its preview. */
let saveGeneration = 0;

/** The one dry-run both filing and overview share. It hashes every original (up to 10 min), so it
 * is memoised per saveGeneration: a save, an apply or a new add drops the memo, and the next caller
 * starts a fresh run. `jobs.recordDryRun` already arms apply for exactly this call. `DryRunMemo`
 * (model.js) keeps pending and settled-failure apart, so concurrent callers join one pass instead
 * of starting several. */
const dryRuns = new m.DryRunMemo(() => track(api.dryRun()), () => saveGeneration);

function ensureDryRun() {
  return dryRuns.ensure(saveGeneration);
}

/** Boot: the filing lists and the dry-run behind the overview's re-sort item. The count and item
 * 2 appear when the dry-run lands, which is what `aria-live` announces. */
async function bootFiling() {
  await loadFilingLists();
  if (!f().saved) return;
  const memo = await ensureDryRun();
  applyPendingNotice(memo);
  render();
}

async function save(op) {
  if (!op || f().saving) return;
  clearTimeout(checkTimer);
  saveGeneration += 1;
  f().saving = true;
  renderFiling();
  const res = await track(api.saveFiling(m.draftFor(f().saved, f().view, op), false));
  f().saving = false;
  if (!res || !res.ok) {
    f().error = res?.error ?? 'The engine did not answer.';
  } else if (!res.report.ok) {
    placeIssues(op, res.report.errors);
  } else {
    f().changes.push(changeFor(op));
    f().saved = {
      ...f().saved,
      folders: res.report.folders,
      owners: res.report.owners,
      shared_owner: res.report.shared_owner ?? f().saved.shared_owner,
    };
    f().error = null;
    f().fieldError = null;
    f().selected = null;
    f().value = '';
    f().dry = null;
    f().dryGeneration = -1;
    f().showAll = false;
    f().notice = 'ask';
    dryRuns.invalidate(); // the lists changed: the overview will need a fresh dry-run
    // A rename re-files the stored copies, so the row counts on the ask screen follow the save.
    void loadDocs();
  }
  render();
}

async function resort() {
  f().notice = 'running';
  f().error = null;
  render();
  const generation = saveGeneration;
  const res = await track(api.dryRun());
  if (generation !== saveGeneration || res?.stale) {
    // The lists were saved while this ran: its preview describes the old lists. Ask again.
    f().notice = 'ask';
    f().error = 'The lists changed while re-sorting. Re-sort again to see the current moves.';
  } else if (!res || !res.ok) {
    f().error = res?.error ?? 'The engine did not answer.';
    f().notice = 'ask';
  } else {
    f().dry = res.report;
    f().dryGeneration = saveGeneration; // tag the preview: an add later makes it stale
    f().showAll = false;
    f().notice = 'preview';
  }
  render();
}

async function apply() {
  if (f().notice !== 'preview') return;
  f().notice = 'applying';
  render();
  const res = await track(api.resort());
  if (!res || !res.ok) {
    f().error = res?.error ?? 'The engine did not answer.';
    f().notice = 'preview';
  } else {
    f().applied = res.report;
    f().changes = [];
    f().pendingText = null;
    f().dry = null;
    f().dryGeneration = -1;
    dryRuns.invalidate(); // the moves are done: the overview must not count them again
    f().notice = 'done';
    void loadDocs();
  }
  render();
}

function closeNotice() {
  f().notice = null;
  f().pendingText = null;
  selectDefault();
  render();
}

function documentCount(name) {
  if (!state.docs) return 0;
  const key = f().view === 'folders' ? 'folder' : 'owner';
  return state.docs.documents.filter((doc) => doc[key] === name).length;
}

function renderFiling() {
  const s = f();
  $('filingError').hidden = s.error === null;
  $('filingError').textContent = s.error ?? '';
  if (!s.saved) {
    $('nameForm').hidden = true;
    $('noticeCard').hidden = true;
    return;
  }
  const docs = state.docs?.documents ?? [];
  const folders = s.view === 'folders';

  // list pane
  $('addButton').setAttribute('aria-label', folders ? 'add folder' : 'add owner');
  for (const button of $('viewSwitch').querySelectorAll('button')) {
    button.setAttribute('aria-checked', button.dataset.view === s.view ? 'true' : 'false');
  }
  $('listMeta').textContent = m.listMeta(s.view, s.saved, docs.length);
  const rows = $('filingRows');
  rows.replaceChildren();
  if (!folders && s.saved.owners.length === 0) {
    rows.append(el('p', 'empty', `No owners yet. Add the people and companies whose documents these are. Until then every copy is filed under ${s.saved.shared_owner}.`));
  }
  for (const row of m.filingRows(s.view, s.saved, docs, s.changes, s.selected)) {
    if (row.kind === 'item') rows.append(listRow(row, () => pick({ kind: 'item', index: row.index }, row.title)));
    else if (row.kind === 'shared') rows.append(listRow(row, () => pick({ kind: 'shared' }, s.saved.shared_owner)));
    else rows.append(listRow(row, null));
  }

  // path example: follows the field; with the notice up, it shows the last change
  const sel = s.selected;
  let focus = { original: null, value: '', placeholder: '' };
  if (sel?.kind === 'item') focus = { original: currentList()[sel.index], value: s.value, placeholder: '' };
  else if (sel?.kind === 'add') focus = { original: null, value: s.value, placeholder: '' };
  else if (sel?.kind === 'shared') focus = { original: null, value: s.saved.shared_owner, placeholder: '' };
  else {
    const last = [...s.changes].reverse().find((c) => c.list === s.view && c.kind !== 'remove');
    if (last) focus = { original: last.kind === 'rename' ? last.to : null, value: last.kind === 'rename' ? last.to : last.name, placeholder: '' };
  }
  const path = $('pathTokens');
  path.replaceChildren(
    ...m.examplePath(s.view, s.saved, docs, s.changes, focus).map((level) => {
      const node = el('span', level.on ? 'level on' : 'level');
      node.append(el('span', 'level-cap', level.cap));
      const val = el('span', 'level-val', level.val);
      if (level.sep) val.append(el('span', 'level-sep', level.sep));
      node.append(val);
      return node;
    }),
  );
  $('pathNote').textContent = folders ? m.FOLDER_NOTE : m.OWNER_NOTE;

  const showNotice = s.notice !== null && sel === null;
  $('noticeCard').hidden = !showNotice;
  $('nameForm').hidden = showNotice || sel === null;
  if (showNotice) renderNotice();
  else if (sel) renderForm();
}

function renderNotice() {
  const s = f();
  const card = { pill: 're-sort needed', tone: 'attention', text: '', note: '', resort: true, done: false };
  if (s.notice === 'ask' || s.notice === 'running') {
    card.text = s.changes.length > 0 ? `${m.changeSummary(s.changes)} Re-sorting shows where every filed copy goes with the new lists.` : (s.pendingText ?? '');
    card.note = 'Nothing moves yet. You get a preview first, and your original files are never touched.';
    const resort = m.resortNote(s.changes);
    if (resort) card.note += ` ${resort}`;
  } else if (s.notice === 'preview' || s.notice === 'applying') {
    const problem = m.dryRunProblem(s.dry);
    const count = problem ? 0 : m.moveCount(s.dry);
    card.resort = false;
    card.note = 'Only the filed copies move. Originals are never touched, and a copy you edited after filing is never removed.';
    if (problem) {
      card.pill = 'nothing to re-sort';
      card.tone = 'danger';
      card.text = problem;
    } else if (count === 0) {
      card.pill = 'nothing to move';
      card.tone = 'positive';
      card.text = 'Every filed copy is already where the lists put it.';
    } else {
      card.pill = `${m.copiesLabel(count)} will move`;
      card.text = 'Here is where the filed copies go with the current lists. Check the moves below, then apply them.';
    }
    card.done = problem !== null || count === 0;
  } else if (s.notice === 'done') {
    card.pill = 'filed';
    card.tone = 'positive';
    card.text = m.applySummary(s.applied);
    card.resort = false;
    card.done = true;
  }
  setPill($('noticePill'), card.pill, card.tone);
  $('noticeText').textContent = card.text;
  $('noticeNote').textContent = card.note;
  $('noticeNote').hidden = card.note === '';
  $('resortButton').hidden = !card.resort;
  $('resortButton').disabled = s.notice === 'running' || s.saving;
  $('resortButton').textContent = s.notice === 'running' ? 're-sorting…' : 're-sort documents';
  $('noticeDone').hidden = !card.done;

  const plan = (s.notice === 'preview' || s.notice === 'applying') && m.dryRunProblem(s.dry) === null ? m.movePlan(s.dry) : null;
  const moves = plan !== null && plan.count > 0;
  $('movesSection').hidden = !moves;
  if (!moves) return;
  const shown = plan.rows.slice(0, s.showAll ? ALL_ROWS : PREVIEW_ROWS);
  $('moveRows').replaceChildren(
    ...shown.map((row) => listRow({ initials: m.fileType(row.title), title: row.title, subject: row.to, preview: row.from, pill: row.pill }, null)),
  );
  const more = plan.count - shown.length;
  $('movesMore').hidden = more <= 0;
  $('movesMore').textContent = more > 0 ? `and ${more} more` : '';
  $('applyButton').textContent = s.notice === 'applying' ? 'moving…' : `move ${m.copiesLabel(plan.count)}`;
  $('applyButton').disabled = s.notice === 'applying' || s.saving;
  $('showAllButton').textContent = `show all ${plan.count}`;
  $('showAllButton').hidden = s.showAll || plan.count <= PREVIEW_ROWS;
  $('laterButton').disabled = s.notice === 'applying';
}

function renderForm() {
  const s = f();
  const sel = s.selected;
  const folders = s.view === 'folders';
  const word = folders ? 'folder' : 'owner';
  const form = { title: '', meta: '', label: `${word} name`, placeholder: '', save: 'save name', glyph: false, remove: '', note: m.RESORT_NOTE, helper: '', readonly: false };
  if (sel.kind === 'item') {
    const name = currentList()[sel.index];
    form.title = name;
    form.meta = `${m.docsLabel(documentCount(name))} filed here`;
    form.remove = `remove ${word}`;
    if (s.value.trim() === name) {
      form.note = folders
        ? 'Removing a folder deletes no documents. They are re-sorted into the folders that are left.'
        : `Removing an owner deletes no documents. They are re-sorted to the owners that are left, or to ${s.saved.shared_owner}.`;
    }
  } else if (sel.kind === 'add') {
    form.title = `add ${word}`;
    form.meta = 'Spell it the way the folder should read.';
    form.placeholder = folders ? 'e.g. Vehicles' : 'e.g. Alex Example';
    form.save = `add ${word}`;
    form.glyph = true;
  } else {
    const shared = s.saved.shared_owner;
    const n = m.sharedOwnerCount(s.saved, state.docs?.documents ?? null);
    form.title = shared;
    form.meta = `${m.docsLabel(n)} filed here`;
    form.label = 'shared folder name';
    form.helper = 'For documents that belong to nobody on the list, or to several people.';
    form.note = 'Saved as shared_owner in config.toml. Re-sorting files unlisted documents under the new name.';
  }
  $('formTitle').textContent = form.title;
  $('formMeta').textContent = form.meta;
  $('nameLabel').textContent = form.label;
  const input = $('nameInput');
  if (input.value !== s.value) input.value = s.value;
  input.placeholder = form.placeholder;
  input.readOnly = form.readonly;
  input.setAttribute('aria-invalid', s.fieldError ? 'true' : 'false');
  const helper = $('nameHelper');
  helper.textContent = s.fieldError ?? form.helper;
  helper.hidden = !s.fieldError && !form.helper;
  helper.classList.toggle('error-text', Boolean(s.fieldError));
  $('saveLabel').textContent = s.saving ? 'saving…' : form.save;
  $('saveGlyph').toggleAttribute('hidden', !form.glyph); // an SVG element has no .hidden property
  $('saveButton').disabled = form.readonly || s.saving || s.fieldError !== null || currentOp() === null;
  $('removeButton').hidden = form.remove === '';
  $('removeButton').textContent = form.remove;
  $('removeButton').disabled = s.saving || (folders && s.saved.folders.length <= 1);
  $('formNote').textContent = form.note;
}

// ---- settings ----
// The renderer never owns a theme: main sets `nativeTheme.themeSource`, which flips prefers-color-scheme
// and tokens.css follows it. The page only shows what `api.settings()` reports. open at login mirrors the
// OS login item, so every reply re-reads the real state and the page paints from that.

async function loadSettings() {
  const res = await track(api.settings());
  if (res) state.settings = { appearance: res.appearance, openAtLogin: res.openAtLogin === true, memGb: typeof res.memGb === 'number' ? res.memGb : 0 };
  renderSettings();
  return res;
}

function renderSettings() {
  const s = state.settings;
  for (const button of $('appearance').querySelectorAll('button')) {
    button.setAttribute('aria-checked', button.dataset.value === s.appearance ? 'true' : 'false');
  }
  $('loginSwitch').checked = s.openAtLogin;
}

/** Send one setting and repaint from the truth that comes back; a rejected write snaps back to the truth. */
async function commitSetting(name, value) {
  const res = await track(api.setSetting(name, value));
  if (res) state.settings = { appearance: res.appearance, openAtLogin: res.openAtLogin === true };
  else await loadSettings();
  renderSettings();
}

// ---- first-run onboarding (LET-136) ----
//
// The step screen: `setupDone:false` from settings replaces the sidebar and every screen. Each
// step opens pre-filled from an engine report; the page only collects choices, and the LAST
// continue ("start filing") sends them to main once. Nothing is written until then.

const ob = state.onboarding;

function obClearTimers() {
  if (ob.recheck !== null) {
    clearTimeout(ob.recheck);
    ob.recheck = null;
  }
  if (ob.poll !== null) {
    clearInterval(ob.poll);
    ob.poll = null;
  }
}

// The design's four-step list. The middle one ("folders and owners") is drawn skipped — a dashed
// circle with "–", never the current step; done steps get the check glyph; only the current step
// carries `aria-current="step"`.
function obRenderStepList() {
  const ol = $('setupStepsList');
  ol.replaceChildren();
  for (let i = 0; i < 4; i += 1) {
    const s = m.setupSteps(ob.step)[i];
    const li = el('li', `step-${s.state}`);
    const dot = el('span', 'step-dot');
    if (s.state === 'done') dot.append(icon('check', 14));
    else if (s.state === 'skipped') dot.append(el('span', '', '–'));
    else dot.append(el('span', '', String(i + 1)));
    li.append(dot, el('span', 'step-label', s.title));
    if (s.state === 'done') li.append(el('span', 'sr', ', done'));
    if (s.state === 'current') li.setAttribute('aria-current', 'step');
    ol.append(li);
  }
}

function obField(labelText, inputId, opts) {
  const wrap = el('label', 'field-wrap');
  wrap.append(el('span', 'field-label', labelText));
  const field = el('span', 'field');
  const input = el('input');
  input.id = inputId;
  input.type = 'text';
  input.autocomplete = 'off';
  if (opts.readonly) input.readOnly = true;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.value) input.value = opts.value;
  if (opts.helper) {
    input.setAttribute('aria-describedby', `${inputId}Helper`);
  }
  field.append(input);
  wrap.append(field);
  if (opts.helper) {
    const helper = el('span', 'helper');
    helper.id = `${inputId}Helper`;
    helper.textContent = opts.helper;
    wrap.append(helper);
  }
  return { wrap, input };
}

// Step 1 (library location): the folder is a read-only field showing the engine's effective value;
// the OS picker or "use the recommended folder" (only when an iCloud folder is picked) change it.
function obBuildLibrary() {
  const body = el('div', 'step-content');
  body.append(obField('library folder', 'libField', { readonly: true, value: ob.libPath, helper: 'Recommended: on this Mac, inside Documents.' }).wrap);
  const btns = el('div', 'step-btns');
  const choose = el('button', 'btn secondary');
  choose.type = 'button';
  choose.append(el('span', '', 'choose folder'));
  choose.addEventListener('click', () => void obPickFolder(false));
  btns.append(choose);
  if (m.isICloudPath(ob.libPath)) {
    const useRec = el('button', 'btn ghost');
    useRec.type = 'button';
    useRec.append(el('span', '', 'use the recommended folder'));
    useRec.addEventListener('click', () => {
      ob.libPath = ob.recommended;
      render();
    });
    btns.append(useRec);
  }
  body.append(btns);
  if (m.isICloudPath(ob.libPath)) {
    const note = el('div', 'model-card icloud-note');
    note.setAttribute('role', 'note');
    note.append(pill('turn on keep downloaded', 'attention'));
    note.append(el('p', '', 'In Finder, Control-click the library folder and choose Keep Downloaded. Otherwise rag docs can’t read files that are stored only in iCloud.'));
    note.append(el('span', 'model-note', 'Copies in iCloud Drive are uploaded to Apple’s iCloud. The model and the search index stay on this Mac.'));
    body.append(note);
  }
  return body;
}

// Step 2 (folders to watch): a 44px switch row per folder — label is the folder's name, the muted
// note is the engine's path — plus "add folder" (the OS picker). Turn off any you do not want read.
// Under the list: the design's muted line, then the board's answer — watching is a follow-up, so
// the screen says so instead of promising it.
function obBuildWatch() {
  const body = el('div', 'step-content');
  const rows = el('div', 'watch-rows');
  for (const w of ob.watch) {
    const row = el('div', 'watch-row');
    row.append(el('span', 'switch-label', m.basename(w.path)));
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', w.path);
    sw.checked = w.on;
    sw.addEventListener('input', () => {
      w.on = sw.checked;
      render();
    });
    row.append(sw);
    row.append(el('span', 'watch-note', w.path));
    rows.append(row);
  }
  body.append(rows);
  const btns = el('div', 'step-btns');
  const add = el('button', 'btn secondary');
  add.type = 'button';
  add.append(icon('plus', 18), el('span', '', 'add folder'));
  add.addEventListener('click', () => void obPickFolder(true));
  btns.append(add);
  body.append(btns);
  body.append(el('span', 'watch-muted', m.SETUP_COPY.watchMuted));
  body.append(el('span', 'watch-muted', m.SETUP_COPY.watchLater));
  return body;
}

// Step 3 (folders and owners): the folders block is the filing list shown as text (the default list,
// edited later in filing); owners are added through the name field + "add owner", and every added
// owner becomes a simple row under the field (name, 44px remove button) reusing the filing row style.
function obBuildFiling() {
  const body = el('div', 'step-content');
  const folders = el('div', 'step-section');
  folders.append(el('span', 'subhead', 'folders'));
  folders.append(el('p', 'folders-list', (ob.filing?.folders ?? []).join(', ')));
  folders.append(el('span', 'model-note', 'The default list. Rename or add folders later in filing.'));
  body.append(folders);
  const owners = el('div', 'step-section');
  owners.append(el('span', 'subhead', 'owners'));
  owners.append(obField('owner name', 'ownerField', { placeholder: 'e.g. Jan Kowalski', helper: 'Whose documents these are: a family member or one of your own companies.' }).wrap);
  const btns = el('div', 'step-btns');
  const add = el('button', 'btn secondary');
  add.type = 'button';
  add.append(icon('plus', 18), el('span', '', 'add owner'));
  add.addEventListener('click', () => {
    const input = document.getElementById('ownerField');
    const name = input ? input.value.trim() : '';
    if (name === '' || ob.owners.includes(name)) {
      render();
      return;
    }
    ob.owners.push(name);
    render();
  });
  btns.append(add);
  body.append(btns);
  const rows = el('div', 'owner-rows');
  for (const name of ob.owners) {
    const row = el('div', 'owner-row');
    row.append(el('span', 'row-title', name));
    const remove = el('button', 'btn ghost');
    remove.type = 'button';
    remove.append(el('span', '', 'remove'));
    remove.addEventListener('click', () => {
      ob.owners = ob.owners.filter((x) => x !== name);
      render();
    });
    row.append(remove);
    rows.append(row);
  }
  owners.append(rows);
  owners.append(el('span', 'model-note', m.SETUP_COPY.ownersMuted));
  body.append(owners);
  return body;
}

// Step 4 (model): the card `m.modelView` shapes — pill, line, optional bar (the engine's own
// numbers), note, the `[llm]`-over-shared note, and the state's actions — plus the model segmented
// control when there are choices and the runtime address field. Not-found re-checks itself every
// 3 s; a finished download is confirmed by the engine's completion probe (`model.answering`) before
// the step may say "ready".
function obBuildModel() {
  const body = el('div', 'step-content');
  const view = m.modelView(ob.viewState, {
    runtime: ob.stepModel?.runtime ?? 'ollama',
    url: ob.stepModel?.url ?? ob.address,
    model: ob.chosenModel || ob.stepModel?.model || ob.pull?.model || '',
    memGb: state.settings.memGb,
    overridden: ob.stepModel?.overridden ?? false,
    recommend: ob.stepModel?.recommend ?? m.recommendedModel((state.settings.memGb || 16) * 1024 ** 3),
    usable: ob.models,
    pull: ob.pull,
    error: ob.pullError,
  });
  const card = el('div', 'model-card');
  card.setAttribute('role', 'status');
  card.append(pill(view.pill, view.tone));
  card.append(el('p', '', view.text));
  if (view.bar) {
    const bar = el('div', 'progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `downloading ${view.barModel}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(ob.pull?.pct ?? 0)));
    const fill = el('div', 'fill');
    fill.style.width = `${Math.min(100, Math.max(0, Math.round(ob.pull?.pct ?? 0)))}%`;
    bar.append(fill);
    card.append(bar);
    card.append(el('span', 'bar-meta', view.bar));
  }
  if (view.note) card.append(el('span', 'model-note', view.note));
  if (view.ob) card.append(el('span', 'model-note', m.OVERRIDDEN_NOTE));
  for (const a of view.actions) {
    const button = el('button', `btn ${a.variant}`);
    button.type = 'button';
    if (a.glyph) button.append(icon(a.glyph, 18));
    button.append(el('span', '', a.label));
    button.addEventListener('click', () => void modelAction(a.label));
    card.append(button);
  }
  body.append(card);
  if (view.models.length > 0) {
    const row = el('div', 'model-row');
    row.append(el('span', 'model-label', 'model'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'model');
    for (const id of view.models) {
      const option = el('button', '');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.dataset.value = id;
      option.setAttribute('aria-checked', (ob.chosenModel || ob.stepModel?.model) === id ? 'true' : 'false');
      option.append(el('span', '', id));
      option.addEventListener('click', () => {
        ob.chosenModel = id;
        render();
      });
      seg.append(option);
    }
    row.append(seg);
    row.append(el('span', 'model-note', view.modelNote));
    body.append(row);
  }
  if (view.hasAddress) {
    body.append(obField('runtime address', 'addressField', { placeholder: 'http://localhost:11434', value: ob.address, helper: 'Another port or runtime? Type its address.' }).wrap);
  }
  if (ob.error !== null) {
    const err = el('p', 'step-error');
    err.setAttribute('role', 'alert');
    err.textContent = ob.error;
    body.append(err);
  }
  return body;
}

function modelAction(label) {
  if (label === 'install Ollama') {
    // One hand-off of the fixed URL to the OS browser (main's only openExternal); the step keeps
    // re-checking itself either way.
    void track(api.installOllama());
    return;
  }
  if (label === 'check again' || label === 'try again') {
    obClearTimers();
    void obDetect();
    return;
  }
  if (label === 'cancel download') {
    ob.cancelled = true;
    void track(api.cancelPull());
    return; // cancel → re-detect when the pull reports it stopped
  }
  if (label.startsWith('download ')) {
    startDownload(label.slice('download '.length));
    return;
  }
  if (label === 'use another model') {
    // The shared block stays unless the user picks a different model from this runtime's list.
    ob.overrideShared = true;
    ob.models = (ob.detect?.runtimes ?? []).flatMap((r) => (r.reachable ? r.usable ?? [] : []));
    render();
  }
}

function obClearAddressFromField() {
  const field = document.getElementById('addressField');
  if (field) ob.address = field.value.trim();
}

function startDownload(modelId) {
  const url = ob.stepModel?.url ?? '';
  ob.pull = { model: modelId, done: 0, gb: 0, pct: 0 };
  ob.viewState = 'downloading';
  ob.pullError = null;
  ob.cancelled = false;
  ob.pullRunning = true;
  // A download streams for minutes: the page never awaits it and never tracks it (it would never
  // settle). The bar reads `modelPullStatus` every 500 ms — engine numbers, painted as data — and
  // the pull result lands success/failed when it arrives.
  void api.modelPull(modelId, url === '' ? undefined : url).then((res) => void onPullResult(modelId, res));
  ob.poll = setInterval(() => void obPollBar(), 500);
  render();
}

async function obPollBar() {
  if (!ob.pullRunning || ob.poll === null) return;
  const res = await api.modelPullStatus();
  if (ob.pullRunning && res && ob.poll !== null) {
    ob.pull = { model: res.model || ob.pull?.model || '', done: res.done ?? 0, gb: res.gb ?? 0, pct: res.pct ?? 0 };
    render();
  }
}

function onPullResult(modelId, res) {
  ob.pullRunning = false;
  if (ob.poll !== null) {
    clearInterval(ob.poll);
    ob.poll = null;
  }
  if (!ob.active || ob.step !== 3) return;
  if (ob.cancelled) {
    ob.pull = null;
    ob.chosenModel = '';
    void obDetect(); // "Cancel → re-detect"
    return;
  }
  if (!res || !res.ok) {
    ob.pullError = res?.error ?? 'the engine did not answer';
    ob.viewState = 'failed';
    render();
    return;
  }
  if (res.success !== true) {
    ob.pullError = res.reason ?? 'the download ended before the model finished';
    ob.viewState = 'failed';
    render();
    return;
  }
  // Ready is the board's answer 3: the engine's own completion probe must have answered —
  // `status --json` reports `model.answering`, true only when a tiny completion came back from the
  // model (not just "the port answers"). Until that is true the step never claims ready.
  void track(api.status()).then((st) => {
    if (!ob.active) return;
    if (st && st.ok && st.report?.model?.answering === true) {
      ob.viewState = 'ready';
      ob.chosenModel = modelId;
      if (ob.stepModel) ob.stepModel = { ...ob.stepModel, state: 'found', model: modelId };
    } else {
      ob.viewState = 'failed';
      ob.pullError = 'the model was downloaded, but it did not answer the test question.';
    }
    render();
  });
}

async function obDetect() {
  obClearAddressFromField();
  const res = await track(api.modelDetect(ob.address === '' ? undefined : ob.address));
  if (!ob.active || ob.step !== 3) return;
  if (!res || !res.ok) {
    ob.stepModel = null;
    ob.detect = null;
    ob.viewState = 'not-found';
    scheduleRecheck();
    render();
    return;
  }
  ob.detect = res.report;
  ob.chosenModel = '';
  const step = m.stepFromDetect(res.report, (state.settings.memGb || 16) * 1024 ** 3);
  ob.stepModel = step;
  if (step.state === 'shared' && ob.overrideShared === true) {
    ob.viewState = 'found';
    ob.models = (res.report.runtimes ?? []).flatMap((r) => (r.reachable ? r.usable ?? [] : []));
  } else if (step.state === 'shared') {
    ob.viewState = 'shared';
    ob.models = [];
  } else if (step.state === 'found') {
    ob.viewState = 'found';
    ob.models = (res.report.runtimes ?? []).flatMap((r) => (r.reachable && (r.usable ?? []).includes(step.model) ? r.usable : []));
  } else {
    ob.viewState = step.state;
    if (step.state === 'not-found') scheduleRecheck();
  }
  render();
}

function scheduleRecheck() {
  if (ob.recheck !== null) {
    clearTimeout(ob.recheck);
    ob.recheck = null;
  }
  ob.recheck = setTimeout(() => {
    ob.recheck = null;
    if (ob.active && ob.step === 3 && ob.viewState === 'not-found') void obDetect();
  }, 3000);
}

async function obPickFolder(isWatch) {
  const res = await track(api.pickFolder());
  if (!res || !res.ok || res.canceled === true || typeof res.path !== 'string') {
    render();
    return;
  }
  if (isWatch) {
    if (!ob.watch.some((w) => w.path === res.path)) ob.watch.push({ path: res.path, on: true });
  } else {
    ob.libPath = res.path;
  }
  render();
}

function obStepBody() {
  if (ob.step === 0) return obBuildLibrary();
  if (ob.step === 1) return obBuildWatch();
  if (ob.step === 2) return obBuildFiling();
  return obBuildModel();
}

function renderOnboarding() {
  obRenderStepList();
  const stepCopy = m.SETUP_COPY[['library', 'watch', 'filing', 'model'][ob.step]];
  $('stepTitle').textContent = stepCopy.title;
  $('stepText').textContent = stepCopy.text;
  $('stepBody').replaceChildren(obStepBody());
  // back / skip / continue: back from every step but the first; skip only on the skippable
  // folders-and-owners step; continue's label is the design's, and only continue may ever be
  // disabled (aria-disabled while the model step is still detecting).
  $('stepBack').hidden = ob.step === 0;
  $('stepSkip').hidden = ob.step !== 2;
  const cont = $('stepContinue');
  const label = ob.step < 3 ? 'continue' : obModelNextLabel();
  $('stepContinueLabel').textContent = label;
  const off = ob.step === 3 && ob.viewState === 'detecting';
  cont.setAttribute('aria-disabled', off ? 'true' : 'false');
  cont.disabled = off;
  cont.className = `btn ${ob.step === 3 && (ob.viewState === 'not-found' || ob.viewState === 'failed') ? 'secondary' : 'primary'}`;
}

function obModelNextLabel() {
  if (ob.viewState === 'detecting') return 'continue';
  if (ob.viewState === 'not-found' || ob.viewState === 'failed') return 'set up later';
  return 'start filing';
}

// Navigation. Steps 1-3 never write: "continue" means "use what is shown"; skip on the owners
// step leaves the lists untouched. The model step's continue is the LAST one: main runs the writes.
function obGoStep(step) {
  ob.step = step;
  if (step === 3) {
    ob.viewState = 'detecting';
    void obDetect();
  }
  if (step === 2 && ob.filingLoaded !== true) {
    ob.filingLoaded = true;
    void track(api.filing()).then((res) => {
      ob.filing = res && res.ok ? res.report : null;
      if (ob.active && ob.step === 2) render();
    });
  }
  render();
}

function obContinue() {
  if (ob.step === 3) {
    void obFinish();
    return;
  }
  obGoStep(ob.step + 1);
}

function obSkip() {
  // Skip on the owners step: the existing lists stand, nothing was added, so no owner save follows.
  ob.owners = [];
  obGoStep(3);
}

function obBack() {
  if (ob.step === 0) return;
  const target = ob.step - 1;
  obClearTimers();
  obGoStep(target);
}

// The last continue: send the choices once. `model` travels when one is chosen and the shared block
// is not being kept; during a download it travels too, and main runs the save when the job reports
// success (never while the stream is open).
async function obFinish() {
  const watchFolders = ob.watch.filter((w) => w.on).map((w) => w.path);
  const payload = { library_dir: ob.libPath, watch_folders: watchFolders };
  if (ob.owners.length > 0) payload.owners = ob.owners;
  const chosen = ob.chosenModel || ob.stepModel?.model || '';
  const keepShared = ob.stepModel?.state === 'shared' && ob.overrideShared !== true;
  if (chosen !== '' && !keepShared) {
    payload.model = { runtime: ob.stepModel?.runtime ?? 'ollama', url: ob.stepModel?.url ?? ob.address, model: chosen };
  }
  const res = await track(api.modelSetup(payload));
  if (!res || !res.ok) {
    // Stay on the step and say which failed: re-continuing is safe (an unchanged engine save writes
    // nothing), per the main-side contract.
    ob.error = res?.error ?? 'the setup did not go through';
    render();
    return;
  }
  obClearTimers();
  ob.active = false;
  ob.done = true;
  state.settings.setupDone = true;
  showSection('overview');
  void loadDocs();
  void loadOverview();
  void bootFiling();
}

function startOnboarding() {
  ob.active = true;
  ob.step = 0;
  render();
  void track(api.setupShow()).then((res) => {
    if (!res || !res.ok) {
      ob.error = res?.error ?? 'the engine did not answer.';
      render();
      return;
    }
    ob.show = res.report;
    ob.recommended = res.report.recommended_library_dir;
    ob.libPath = res.report.library_dir_set === true ? res.report.library_dir : res.report.recommended_library_dir;
    ob.watch = m.watchRows(res.report).map((w) => ({ path: w.path, on: true }));
    render();
  });
}

function wire() {
  for (const button of document.querySelectorAll('.nav button')) {
    button.addEventListener('click', () => showSection(button.dataset.section));
  }
  $('askForm').addEventListener('submit', (event) => void ask(event));
  $('librarySearch').addEventListener('input', onSearchChange);
  $('librarySearch').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    $('librarySearch').value = '';
    onSearchChange(); // empty box restores the full list
  });
  $('addDocsButton').addEventListener('click', () => void addDocs());
  $('libraryFilterClear').addEventListener('click', () => {
    state.libraryFilter = null;
    render();
  });
  $('addCancel').addEventListener('click', () => void cancelAdd());
  $('cancelAsk').addEventListener('click', () => void cancelAsk());
  $('copyAnswer').addEventListener('click', () => void copyAnswer());

  for (const button of $('viewSwitch').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (!f().saved || f().view === button.dataset.view) return;
      f().view = button.dataset.view;
      f().touched = true;
      f().error = null;
      if (f().notice !== null) f().selected = null;
      else selectDefault();
      render();
    });
  }
  $('addButton').addEventListener('click', () => {
    if (f().saved) pick({ kind: 'add' }, '');
    $('nameInput').focus();
  });
  $('nameInput').addEventListener('input', () => {
    f().value = $('nameInput').value;
    f().fieldError = null;
    renderFiling();
    scheduleCheck();
  });
  $('nameForm').addEventListener('submit', (event) => {
    event.preventDefault();
    void save(currentOp());
  });
  $('removeButton').addEventListener('click', () => {
    const sel = f().selected;
    if (sel?.kind === 'item') void save({ kind: 'remove', index: sel.index });
  });
  $('resortButton').addEventListener('click', () => void resort());
  $('applyButton').addEventListener('click', () => void apply());
  $('showAllButton').addEventListener('click', () => {
    f().showAll = true;
    render();
  });
  $('laterButton').addEventListener('click', closeNotice);
  $('noticeDone').addEventListener('click', closeNotice);

  // settings: the segmented control picks an appearance; the checkbox is a switch that writes the
  // login item. Both repaint from the truth main sends back.
  for (const button of $('appearance').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (state.settings.appearance === button.dataset.value) return;
      void commitSetting('appearance', button.dataset.value);
    });
  }
  $('loginSwitch').addEventListener('change', () => {
    void commitSetting('openAtLogin', $('loginSwitch').checked);
  });

  // macOS lets the user change the login item in System Settings while the app is open; refocusing
  // re-reads it, so the switch never shows a state the OS no longer has. The overview re-reads its
  // two engine calls the same way: the window you look at is the window that is true. The onboarding
  // gate is re-checked on focus too: while the step screen is up, the overview must not load behind
  // it; once `setupDone` landed (from the last continue), normal loading resumes.
  window.addEventListener('focus', () => {
    void loadSettings().then((res) => {
      if (res && res.setupDone === true && !state.onboarding.active) void loadOverview();
    });
  });

  // Onboarding: the three design buttons; the step's own controls are (re)built inside #stepBody
  // on every render, so their listeners travel with the nodes.
  $('stepContinue').addEventListener('click', () => void obContinue());
  $('stepSkip').addEventListener('click', () => void obSkip());
  $('stepBack').addEventListener('click', () => obBack());
}

document.body.dataset.pending = '0';
sidebar.build($('sidebar'));
wire();
render();

// Boot gate (the plan's): read settings first; only if `setupDone` do the normal loads start
// (no 10-minute dry-run before setup). A false `setupDone` opens the step screen instead.
async function boot() {
  const res = await loadSettings();
  if (res && res.setupDone === true) {
    state.settings.setupDone = true;
    void loadDocs();
    void loadOverview();
    void bootFiling();
  } else {
    startOnboarding();
  }
}

void boot();
