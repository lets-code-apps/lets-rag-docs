// First-run onboarding logic that needs neither Electron nor a running engine: picking a model by
// the Mac's memory, building the engine argv for `model detect | pull | save`, reading the `model
// detect` answer down to the fields the step reads, shaping one `model pull` progress line into a GB
// bar, and validating the `setup save` draft (the library folder and the folders-to-watch list).
//
// The model functions are the SAME code lets-triage-mail runs (PR #26): both apps speak one JSON and
// share one `model.toml`, so their model argv builders and parsers must not drift. The engine
// validates every value again; this gate is the first check, not the only one, and never decides what
// a value *means*. Nothing here opens a socket: the engine makes every network call (see desktop/README.md).

// The runtime words `model save --runtime` accepts (the Rust `Runtime` enum in src/shared_model.rs).
export const MODEL_RUNTIMES = ['ollama', 'lmstudio', 'custom'] as const;
// The one page "install Ollama" may open. main hands it to `shell.openExternal` with no argument built
// from user input, so this stays a fixed constant, not a URL the page can change.
export const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

// Pick the recommended model by the Mac's memory. The engine's own thresholds win: a small Mac gets
// the small model, so a pull never tries to load more than the machine has.
const GB = 1024 ** 3;
export function recommendedModel(totalBytes: number): { model: string; sizeGb: number } {
	const mem = totalBytes / GB;
	if (mem < 12) return { model: 'qwen3:4b', sizeGb: 2.5 };
	if (mem < 32) return { model: 'qwen3:8b', sizeGb: 5.2 };
	return { model: 'qwen3:14b', sizeGb: 9.3 };
}

// Validation for the model argv: a closed runtime set, a model id that can never read as a flag, and
// an address with no spaces and no leading dash. The engine re-checks each (and enforces the local-only
// rule), so this builder only refuses what cannot be a valid value at all.
const MODEL_ID = /^[A-Za-z0-9:._-]{1,128}$/;
const URL_TEXT = /^[^\s\0]{1,254}$/;
const runtimeWord = (v: unknown): v is string => typeof v === 'string' && (MODEL_RUNTIMES as readonly string[]).includes(v);
const urlText = (v: unknown): v is string => typeof v === 'string' && URL_TEXT.test(v) && !v.startsWith('-');
const modelId = (v: unknown): v is string => typeof v === 'string' && MODEL_ID.test(v) && !v.startsWith('-');

// `model detect [--url ADDR] --json`: no model id; `--url` only when the page typed one.
export function buildModelDetectArgs(url?: unknown): string[] | null {
	if (url === undefined || url === null || url === '') return ['detect', '--json'];
	if (!urlText(url)) return null;
	return ['detect', '--json', `--url=${url}`];
}

// `model pull --json [--url ADDR] -- MODEL`: the model id is a positional after `--`, the value flags
// use `--flag=value`, so nothing typed can read as a flag.
export function buildModelPullArgs(model: unknown, url?: unknown): string[] | null {
	if (!modelId(model)) return null;
	if (url !== undefined && url !== null && url !== '' && !urlText(url)) return null;
	return ['pull', '--json', ...(url ? [`--url=${url}`] : []), '--', model];
}

// `model save --json --runtime R --url U --model M`: all three are validated values.
export function buildModelSaveArgs(runtime: unknown, url: unknown, model: unknown): string[] | null {
	if (!runtimeWord(runtime) || !urlText(url) || !modelId(model)) return null;
	return ['save', '--json', `--runtime=${runtime}`, `--url=${url}`, `--model=${model}`];
}

// The download bar's accessible values and fill width for one progress percent, clamped to 0..100. The
// maximum is always 100 and the fill is that same percent, so a partial download (e.g. 42%) never reads
// as complete to a screen reader or in the painted bar.
export function progressBar(pct: number): { valuemin: 0; valuemax: 100; valuenow: number; fill: string } {
	const now = Math.min(100, Math.max(0, Math.round(pct) || 0));
	return { valuemin: 0, valuemax: 100, valuenow: now, fill: `${now}%` };
}

// What `model detect --json` answered (src/model_setup.rs detect_json, shape-locked by a Rust test):
// one probe per runtime plus the shared file's block, if any. Trimmed to the fields the step reads.
export type RuntimeProbe = { runtime: string; url: string; reachable: boolean; usable: string[]; error: string | null };
export type SharedModelBlock = { runtime: string; url: string; model: string; setBy: string; reachable: boolean };
export type ModelDetect = { ok: boolean; runtimes: RuntimeProbe[]; shared: SharedModelBlock | null; error: string | null };

export function parseModelDetect(raw: Record<string, unknown>): ModelDetect {
	if (raw.ok !== true) {
		return { ok: false, runtimes: [], shared: null, error: typeof raw.error === 'string' ? raw.error : 'the engine gave no answer' };
	}
	const probe = (v: unknown): RuntimeProbe | null => {
		if (typeof v !== 'object' || v === null || typeof (v as RuntimeProbe).url !== 'string') return null;
		const found = v as Record<string, unknown>;
		return {
			runtime: typeof found.runtime === 'string' ? found.runtime : 'custom',
			url: String(found.url),
			reachable: found.reachable === true,
			usable: Array.isArray(found.usable) ? found.usable.filter((id) => typeof id === 'string') : [],
			error: typeof found.error === 'string' ? found.error : null,
		};
	};
	const block = raw.shared && typeof raw.shared === 'object' && !Array.isArray(raw.shared) ? (raw.shared as Record<string, unknown>) : null;
	return {
		ok: true,
		runtimes: (Array.isArray(raw.runtimes) ? raw.runtimes : []).flatMap((v) => {
			const p = probe(v);
			return p === null ? [] : [p];
		}),
		shared:
			block === null
				? null
				: {
						runtime: typeof block.runtime === 'string' ? block.runtime : 'custom',
						url: typeof block.url === 'string' ? block.url : '',
						model: typeof block.model === 'string' ? block.model : '',
						setBy: typeof block.set_by === 'string' ? block.set_by : '',
						reachable: block.reachable === true,
					},
		error: null,
	};
}

// One normalised `model pull` line (`{"stage": ...}`, src/model_setup.rs normalise_pull_line). The
// desktop never re-reads raw Ollama text: the engine already shaped it.
export type PullLine = { stage: 'pulling manifest' | 'downloading' | 'success' | 'error' | 'other'; total: number; completed: number; text: string };

export function parsePullLine(line: string): PullLine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const known = ['pulling manifest', 'downloading', 'success', 'error', 'other'] as const;
	const stage = known.includes(obj.stage as (typeof known)[number]) ? (obj.stage as PullLine['stage']) : 'other';
	return {
		stage,
		total: typeof obj.total === 'number' ? obj.total : 0,
		completed: typeof obj.completed === 'number' ? obj.completed : 0,
		text: typeof obj.error === 'string' ? obj.error : typeof obj.status === 'string' ? obj.status : '',
	};
}

// The progress bar for a `downloading` line: bytes become GB (the design's bar is labelled in GB), and
// pct comes from the engine's own numbers, never a guess. (GB is the same constant recommendedModel sizes
// against.)
const round1 = (x: number): number => Math.round(x * 10) / 10;
export function pullProgress(model: string, line: PullLine): { model: string; done: number; gb: number; pct: number } | null {
	if (line.stage !== 'downloading' || line.total <= 0) return null;
	return { model, done: round1(line.completed / GB), gb: round1(line.total / GB), pct: Math.round((line.completed / line.total) * 100) };
}

// The `setup save` draft (src/setup.rs Draft): the library folder and the folders-to-watch list, sent
// as one JSON object on the engine's stdin (paths never travel in argv, where a process list could
// expose them). The engine is the authority; this builder only refuses values that could not be a
// valid path (relative, empty, over 4096 chars, or a NUL), and caps the list at 20 like the engine does.
// A value is a usable path when it is absolute (`/...`) or home-relative (`~` or `~/...`).
const SETUP_PATH = /^(~|\/|~\/)/;
const setupPath = (v: unknown): v is string =>
	typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\u{0}') && SETUP_PATH.test(v);

// The shape the page sends to `rag.modelSetup` (the last "continue"): the two setup fields, an owner
// only when one was added, a model only when one is chosen and not already the shared block. main
// validates each with the same builders it uses for the individual saves, then runs them in a fixed order.
export type ModelSetupRun = {
	library_dir: string;
	watch_folders: string[];
	owners?: string[];
	model?: { runtime: string; url: string; model: string } | null;
};

export function buildSetupSaveDraft(libraryDir: unknown, watchFolders: unknown): { library_dir: string; watch_folders: string[] } | null {
	if (!setupPath(libraryDir)) return null;
	if (!Array.isArray(watchFolders)) return null;
	const folders: string[] = [];
	const seen = new Set<string>();
	for (const folder of watchFolders) {
		if (!setupPath(folder)) return null;
		if (seen.has(folder)) return null;
		seen.add(folder);
		folders.push(folder);
	}
	if (folders.length > 20) return null;
	return { library_dir: libraryDir, watch_folders: folders };
}
