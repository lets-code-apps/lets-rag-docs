// Defensive parsers for the engine's JSON reports. The desktop owns the spawn, but every report
// crosses a process boundary and is hostile-shaped data: version wrong, key missing, wrong type,
// empty stdout. Parsers return a clean error (often the engine's first stderr line) rather than
// letting the page try to read a missing field.

export type DocumentsReport = {
	version: number;
	max_file_mb: number | null;
	status: string;
	documents: DocumentRow[];
};

export type DocumentRow = {
	path: string;
	title: string | null;
	type: string;
	date: string | null;
	folder: string | null;
	owner: string | null;
	filed_as: string | null;
	bytes: number | null;
	pages: number | null;
	skipped: string | null;
	dataless: boolean;
};

export type StatusReport = {
	version: number;
	model: ModelStatus;
	last_sync: string | null;
};

export type ModelStatus = {
	reachable: boolean;
};

export type SearchReport = {
	version: number;
	passages: PassageRow[];
};

export type PassageRow = {
	source: string;
	file: string;
	chunk: number;
	page: number | null;
	score: number;
};

export type AddReport = {
	version: number;
	status: string;
	source: string | null;
	file: string | null;
	type: string | null;
	date: string | null;
	chunks: number | null;
	duplicate_of: string | null;
};

export type LocateReport = {
	version: number;
	status: string;
	kind: string | null;
	path: string | null;
};

export type AskReport = {
	version: number;
	answer: string | null;
	sources: SourceRow[];
};

export type SourceRow = {
	source: string;
	file: string;
	chunk: number;
	page: number | null;
	score: number;
};

export type FilingShowReport = {
	version: number;
	folders: string[];
	owners: string[];
	shared_owner: string;
};

export type FilingSaveReport = {
	version: number;
	ok: boolean;
	saved: boolean;
	renamed: number;
	folders: string[];
	owners: string[];
	shared_owner: string | null;
	errors: NameIssueRow[];
};

export type NameIssueRow = {
	list: string;
	index: number | null;
	name: string | null;
	code: string;
	message: string;
};

export type OrganizeReport = {
	version: number;
	mode: string;
	status: string;
	items: PlanItemRow[];
	counts: Record<string, number>;
};

export type PlanItemRow = {
	action: string;
	from: string;
	to: string | null;
};

export type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function err(message: string): Parse<never> {
	return { ok: false, error: message };
}

function firstLine(stderrTail: string[]): string {
	const line = stderrTail.find((x) => x.trim() !== '');
	return line === undefined ? '' : line.trim();
}

/** The failure line from a real engine error. `tracing` logs share stderr and often come first,
 * so the `Error: ...` line is the answer; if the engine wrote no such line, its last line is. */
export function errorLine(stderrTail: string[]): string {
	const errorLine = [...stderrTail].reverse().find((x) => x.trim().startsWith('Error:'));
	if (errorLine !== undefined) return errorLine.trim();
	const last = [...stderrTail].reverse().find((x) => x.trim() !== '');
	return last === undefined ? '' : last.trim();
}

function parseJson(
	stdout: string,
	stderrTail: string[],
	pick: (tail: string[]) => string = firstLine,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const text = stdout.trim();
	if (text === '') {
		const line = pick(stderrTail);
		if (line !== '') return { ok: false, error: line };
		return { ok: false, error: 'engine printed no JSON on stdout' };
	}
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, error: 'engine stdout is not one JSON object' };
	}
}

function requireVersion(parsed: unknown): boolean {
	return typeof parsed === 'object' && parsed !== null && 'version' in parsed && (parsed as { version: unknown }).version === 1;
}

function stringOrNull(value: unknown): string | null {
	return value === null ? null : typeof value === 'string' ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') return null;
		out.push(item);
	}
	return out;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' ? value : null;
}

export function parseDocuments(stdout: string, stderrTail: string[]): Parse<DocumentsReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('documents report version is not 1');
	const rowObj = parsed.value as { max_file_mb?: unknown; status: unknown; documents: unknown };
	if (typeof rowObj.status !== 'string' || !Array.isArray(rowObj.documents)) return err('documents report is missing status/documents');
	// An engine older than the size limit has no max_file_mb: absent or wrong-typed is null, not a
	// crash and not a fake 50.
	const maxFileMb = numberOrNull(rowObj.max_file_mb);
	const docs: DocumentRow[] = [];
	for (const row of rowObj.documents) {
		if (typeof row !== 'object' || row === null) return err('documents row is not an object');
		const obj = row as { path: unknown; title: unknown; type: unknown; date: unknown; folder: unknown; owner: unknown; filed_as: unknown; bytes?: unknown; pages?: unknown; skipped?: unknown; dataless?: unknown };
		const path = stringOrNull(obj.path);
		const type = stringOrNull(obj.type);
		if (path === null || type === null) return err('documents row has a missing text field');
		// A document the model could not title is still a document: the engine sends `null`.
		if (obj.title !== null && typeof obj.title !== 'string') return err('documents row title must be text or null');
		const title = stringOrNull(obj.title);
		docs.push({
			path,
			title,
			type,
			date: stringOrNull(obj.date),
			folder: stringOrNull(obj.folder),
			owner: stringOrNull(obj.owner),
			filed_as: stringOrNull(obj.filed_as),
			// Sizes, pages and the skip reason arrive with the size limit; an older engine simply
			// omits them, which reads as null (unknown) rather than zero.
			bytes: numberOrNull(obj.bytes),
			pages: numberOrNull(obj.pages),
			skipped: stringOrNull(obj.skipped),
			// The dataless (iCloud-only) bit arrives with the new engine; an older engine
			// simply omits it, which reads as false: nothing is only in iCloud as far as we know.
			dataless: obj.dataless === true,
		});
	}
	return { ok: true, value: { version: 1, max_file_mb: maxFileMb, status: rowObj.status, documents: docs } };
}

/** `status --json`: is the model answering, and when the library was last synced. Both
 * fields are data: `reachable:false` and `last_sync:null` are states, not failures. */
export function parseStatus(stdout: string, stderrTail: string[]): Parse<StatusReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('status report version is not 1');
	const obj = parsed.value as { model?: unknown; last_sync?: unknown };
	if (typeof obj.model !== 'object' || obj.model === null || typeof (obj.model as { reachable?: unknown }).reachable !== 'boolean') {
		return err('status report is missing model.reachable');
	}
	const reachable = (obj.model as { reachable: unknown }).reachable === true;
	// A database that does not exist yet reports null; an older engine may omit the key.
	const lastSync = obj.last_sync === null || obj.last_sync === undefined ? null : stringOrNull(obj.last_sync);
	return { ok: true, value: { version: 1, model: { reachable }, last_sync: lastSync } };
}

export function parseSearch(stdout: string, stderrTail: string[]): Parse<SearchReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('search report version is not 1');
	const obj = parsed.value as { passages: unknown };
	if (!Array.isArray(obj.passages)) return err('search report is missing passages');
	const passages: PassageRow[] = [];
	for (const passage of obj.passages) {
		if (typeof passage !== 'object' || passage === null) return err('search passage is not an object');
		const row = passage as { source: unknown; file: unknown; chunk: unknown; page?: unknown; score: unknown };
		const source = stringOrNull(row.source);
		const file = stringOrNull(row.file);
		if (source === null || file === null) return err('search passage has a missing text field');
		const chunk = numberOrNull(row.chunk);
		const score = numberOrNull(row.score);
		if (chunk === null || score === null) return err('search passage has a missing number field');
		// No page marker in the OCR text means no page: old documents stay honest.
		const page = row.page === null || row.page === undefined ? null : numberOrNull(row.page);
		passages.push({ source, file, chunk, page, score });
	}
	return { ok: true, value: { version: 1, passages } };
}

export function parseAdd(stdout: string, stderrTail: string[]): Parse<AddReport> {
	// An `add` failure's real message is the `Error:` line; tracing logs share stderr ahead of it.
	const parsed = parseJson(stdout, stderrTail, errorLine);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('add report version is not 1');
	const obj = parsed.value as { status: unknown; source?: unknown; file?: unknown; type?: unknown; date?: unknown; chunks?: unknown; duplicate_of?: unknown };
	if (typeof obj.status !== 'string') return err('add report is missing status');
	return {
		ok: true,
		value: {
			version: 1,
			status: obj.status,
			source: stringOrNull(obj.source),
			file: stringOrNull(obj.file),
			type: stringOrNull(obj.type),
			date: stringOrNull(obj.date),
			chunks: numberOrNull(obj.chunks),
			duplicate_of: stringOrNull(obj.duplicate_of),
		},
	};
}

export function parseLocate(stdout: string, stderrTail: string[]): Parse<LocateReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('locate report version is not 1');
	const obj = parsed.value as { status: unknown; kind?: unknown; path?: unknown };
	if (typeof obj.status !== 'string') return err('locate report is missing status');
	return { ok: true, value: { version: 1, status: obj.status, kind: stringOrNull(obj.kind), path: stringOrNull(obj.path) } };
}

export function parseAsk(stdout: string, stderrTail: string[]): Parse<AskReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('ask report version is not 1');
	const obj = parsed.value as { answer: unknown; sources: unknown };
	if (obj.answer !== null && typeof obj.answer !== 'string') return err('ask report answer must be text or null');
	if (!Array.isArray(obj.sources)) return err('ask report sources is not an array');
	const sources: SourceRow[] = [];
	for (const source of obj.sources) {
		if (typeof source !== 'object' || source === null) return err('source row is not an object');
		const row = source as { source: unknown; file: unknown; chunk: unknown; page?: unknown; score: unknown };
		const src = stringOrNull(row.source);
		const file = stringOrNull(row.file);
		if (src === null || file === null) return err('source row has a missing text field');
		const chunk = numberOrNull(row.chunk);
		const score = numberOrNull(row.score);
		if (chunk === null || score === null) return err('source row has a missing number field');
		// The page within the document, when the OCR text has markers; null means unknown.
		const page = row.page === null || row.page === undefined ? null : numberOrNull(row.page);
		sources.push({ source: src, file, chunk, page, score });
	}
	return { ok: true, value: { version: 1, answer: typeof obj.answer === 'string' ? obj.answer : null, sources } };
}

export function parseFilingShow(stdout: string, stderrTail: string[]): Parse<FilingShowReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('filing report version is not 1');
	const obj = parsed.value as { folders: unknown; owners: unknown; shared_owner: unknown };
	const folders = stringArrayOrNull(obj.folders);
	const owners = stringArrayOrNull(obj.owners);
	const shared = stringOrNull(obj.shared_owner);
	if (folders === null || owners === null || shared === null) return err('filing report is missing folder/owner/shared fields');
	return { ok: true, value: { version: 1, folders, owners, shared_owner: shared } };
}

export function parseFilingSave(stdout: string, stderrTail: string[]): Parse<FilingSaveReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('save report version is not 1');
	const obj = parsed.value as {
		ok: unknown;
		saved: unknown;
		renamed?: unknown;
		folders: unknown;
		owners: unknown;
		shared_owner?: unknown;
		errors: unknown;
	};
	if (typeof obj.ok !== 'boolean' || typeof obj.saved !== 'boolean' || !Array.isArray(obj.errors)) return err('save report is missing ok/saved/errors');
	const folders = stringArrayOrNull(obj.folders);
	const owners = stringArrayOrNull(obj.owners);
	if (folders === null || owners === null) return err('save report is missing folder/owner fields');
	const errors: NameIssueRow[] = [];
	for (const issue of obj.errors) {
		if (typeof issue !== 'object' || issue === null) return err('save error row is not an object');
		const row = issue as { list: unknown; index: unknown; name: unknown; code: unknown; message: unknown };
		const list = stringOrNull(row.list);
		const code = stringOrNull(row.code);
		const message = stringOrNull(row.message);
		if (list === null || code === null || message === null) return err('save error row has a missing text field');
		const index = row.index === null ? null : numberOrNull(row.index);
		const name = row.name === null ? null : stringOrNull(row.name);
		if (index === null && row.index !== null) return err('save error index has the wrong type');
		if (name === null && row.name !== null) return err('save error name has the wrong type');
		errors.push({ list, index, name, code, message });
	}
	// `renamed` is how many rows the rename updates touched; an engine without renames reports 0.
	const renamed = typeof obj.renamed === 'number' ? obj.renamed : 0;
	// The shared owner in effect after this save, so the form repaints instead of showing
	// a stale name. null means an older engine that never sends it: the caller keeps its
	// own current value.
	const shared = stringOrNull(obj.shared_owner);
	return { ok: true, value: { version: 1, ok: obj.ok, saved: obj.saved, renamed, folders, owners, shared_owner: shared, errors } };
}

export function parseOrganize(stdout: string, stderrTail: string[]): Parse<OrganizeReport> {
	const parsed = parseJson(stdout, stderrTail);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!requireVersion(parsed.value) || typeof parsed.value !== 'object') return err('organize report version is not 1');
	const obj = parsed.value as { mode: unknown; status: unknown; items: unknown; counts: unknown };
	if (typeof obj.mode !== 'string' || typeof obj.status !== 'string' || !Array.isArray(obj.items) || typeof obj.counts !== 'object' || obj.counts === null) {
		return err('organize report is missing mode/status/items/counts');
	}
	const items: PlanItemRow[] = [];
	for (const item of obj.items) {
		if (typeof item !== 'object' || item === null) return err('organize item is not an object');
		const row = item as { action: unknown; from: unknown; to: unknown };
		const action = stringOrNull(row.action);
		const from = stringOrNull(row.from);
		if (action === null || from === null) return err('organize item is missing action/from');
		items.push({ action, from, to: stringOrNull(row.to) });
	}
	const counts: Record<string, number> = {};
	for (const key of Object.keys(obj.counts)) {
		const value = (obj.counts as Record<string, unknown>)[key];
		if (typeof value !== 'number') return err('organize counts contain a non-number');
		counts[key] = value;
	}
	return { ok: true, value: { version: 1, mode: obj.mode, status: obj.status, items, counts } };
}