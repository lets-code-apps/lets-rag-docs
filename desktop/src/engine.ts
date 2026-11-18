// One-shot engine calls. The desktop never starts a long-lived engine, never reads the config,
// database or documents, and never parses argv supplied by the page: it spawns `lets-rag-docs`
// with fixed argv and reads only stdout/stderr. A real failure has empty stdout and stderr's first
// line; an expected engine state is a JSON report with exit 0.

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import {
	parseAdd,
	parseAsk,
	parseDocuments,
	parseFilingSave,
	parseFilingShow,
	parseLocate,
	parseOrganize,
	parseSearch,
	type AddReport,
	type AskReport,
	type DocumentsReport,
	type FilingSaveReport,
	type FilingShowReport,
	type LocateReport,
	type OrganizeReport,
	type Parse,
	type SearchReport,
} from './reports.ts';
import { resolveEngine } from './engine-path.ts';

export interface EngineProcess extends EventEmitter {
	stdin: NodeJS.WritableStream | null;
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals | number): void;
}

export interface SpawnLike {
	call(file: string, args: readonly string[], options?: SpawnOptions): EngineProcess;
}

export const defaultSpawn: SpawnLike = {
	call(file, args, options) {
		const spawned = nodeSpawn(file, [...args], options ?? { stdio: ['ignore', 'pipe', 'pipe'] });
		return spawned as unknown as EngineProcess;
	},
};

export type EngineOutcome = {
	stdout: string;
	stderrTail: string[];
	exitCode: number | null;
	timedOut: boolean;
};

/** Time budgets per call. Reads are quick; the dry-run hashes every original; apply copies and
 * re-embeds a whole batch through the local model, so it gets a deliberate long-job budget. */
export const TIMEOUTS = {
	readMs: 10_000,
	dryRunMs: 10 * 60_000,
	applyMs: 60 * 60_000,
	askMs: 6 * 60_000,
	addMs: 20 * 60_000,
} as const;

function minutes(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class Engine {
	private readonly env: NodeJS.ProcessEnv;
	private readonly repoRoot: string;
	private readonly spawn: SpawnLike;
	private readonly resourcesPath: string | undefined;
	private readonly readTimeoutMs: number;
	private readonly askTimeoutMs: number;
	private readonly dryRunTimeoutMs: number;
	private readonly applyTimeoutMs: number;
	private readonly addTimeoutMs: number;
	private askChild: EngineProcess | null = null;
	private addChild: EngineProcess | null = null;

	constructor(
		env: NodeJS.ProcessEnv,
		repoRoot: string,
		spawn: SpawnLike = defaultSpawn,
		readTimeoutMs: number = TIMEOUTS.readMs,
		askTimeoutMs: number = TIMEOUTS.askMs,
		resourcesPath: string | undefined = undefined,
		dryRunTimeoutMs: number = TIMEOUTS.dryRunMs,
		applyTimeoutMs: number = TIMEOUTS.applyMs,
		addTimeoutMs: number = TIMEOUTS.addMs,
	) {
		this.env = env;
		this.repoRoot = repoRoot;
		this.spawn = spawn;
		this.readTimeoutMs = readTimeoutMs;
		this.askTimeoutMs = askTimeoutMs;
		this.resourcesPath = resourcesPath;
		this.dryRunTimeoutMs = dryRunTimeoutMs;
		this.applyTimeoutMs = applyTimeoutMs;
		this.addTimeoutMs = addTimeoutMs;
	}

	resolve(): { file: string; baseArgs: string[] } {
		return resolveEngine(this.env, this.resourcesPath, this.repoRoot);
	}

	private async collect(subArgs: string[], stdinText?: string, timeoutMs = this.readTimeoutMs): Promise<EngineOutcome> {
		const { file, baseArgs } = this.resolve();
		const stdinKind = stdinText === undefined ? 'ignore' : 'pipe';
		const child = this.spawn.call(file, [...baseArgs, ...subArgs], { stdio: [stdinKind, 'pipe', 'pipe'] });
		let stdout = '';
		const stderrTail: string[] = [];
		let exitCode: number | null = null;
		let timedOut = false;

		if (child.stdout) child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
		if (child.stderr) {
			child.stderr.on('data', (chunk: unknown) => {
				for (const line of String(chunk).split('\n')) {
					if (line !== '') stderrTail.push(line);
					if (stderrTail.length > 8) stderrTail.shift();
				}
			});
		}
		child.once('exit', (code: number | null) => { exitCode = code; });

		if (child.stdin && stdinText !== undefined) {
			child.stdin.write(stdinText);
			child.stdin.end();
		}

		const closed = new Promise<void>((resolve) => {
			child.once('close', () => resolve());
			child.once('error', () => resolve());
		});

		if (timeoutMs > 0) {
			const outcome = await Promise.race([
				closed.then(() => 'closed' as const),
				delay(timeoutMs).then(() => 'timeout' as const),
			]);
			if (outcome === 'timeout') {
				timedOut = true;
				child.kill('SIGKILL');
				await closed;
			}
		} else {
			await closed;
		}

		return { stdout, stderrTail, exitCode, timedOut };
	}

	private parse<T>(parsed: Parse<T>): EngineResult<T> {
		if (parsed.ok) return { ok: true, value: parsed.value };
		return { ok: false, error: parsed.error };
	}

	/** A killed child may have printed half a report: say it timed out instead of parsing it. */
	private finish<T>(outcome: EngineOutcome, call: string, timeoutMs: number, parse: (o: EngineOutcome) => Parse<T>): EngineResult<T> {
		if (outcome.timedOut) return { ok: false, error: `${call} timed out after ${minutes(timeoutMs)} and was stopped` };
		return this.parse(parse(outcome));
	}

	async documents(): Promise<EngineResult<DocumentsReport>> {
		const outcome = await this.collect(['documents', '--json']);
		return this.finish(outcome, 'documents', this.readTimeoutMs, (o) => parseDocuments(o.stdout, o.stderrTail));
	}

	async filingShow(): Promise<EngineResult<FilingShowReport>> {
		const outcome = await this.collect(['filing', 'show', '--json']);
		return this.finish(outcome, 'filing show', this.readTimeoutMs, (o) => parseFilingShow(o.stdout, o.stderrTail));
	}

	async filingSave(draft: unknown, check: boolean): Promise<EngineResult<FilingSaveReport>> {
		if (typeof draft !== 'object' || draft === null) return { ok: false, error: 'draft must be a JSON object' };
		if (!Array.isArray((draft as { folders?: unknown }).folders) || !Array.isArray((draft as { owners?: unknown }).owners)) {
			return { ok: false, error: 'draft must contain folders and owners arrays' };
		}
		// The draft names never enter argv; still, type-check the new fields here so the engine only
		// ever sees the shape it documents (a stray object must not reach SQLite or config.toml).
		const sharedOwner = (draft as { shared_owner?: unknown }).shared_owner;
		if (sharedOwner !== undefined && typeof sharedOwner !== 'string') {
			return { ok: false, error: 'draft shared_owner must be a string when present' };
		}
		const renames = (draft as { renames?: unknown }).renames;
		if (renames !== undefined) {
			if (!Array.isArray(renames)) return { ok: false, error: 'draft renames must be an array when present' };
			for (const rename of renames) {
				const row = rename as { list?: unknown; from?: unknown; to?: unknown };
				if (typeof rename !== 'object' || rename === null
					|| (row.list !== 'folders' && row.list !== 'owners')
					|| typeof row.from !== 'string' || typeof row.to !== 'string') {
					return { ok: false, error: 'each rename is {list: folders|owners, from, to} with strings' };
				}
			}
		}
		const subArgs = check ? ['filing', 'save', '--check'] : ['filing', 'save'];
		const outcome = await this.collect(subArgs, `${JSON.stringify(draft)}\n`);
		return this.finish(outcome, 'filing save', this.readTimeoutMs, (o) => parseFilingSave(o.stdout, o.stderrTail));
	}

	/** Search is a read: fixed argv, query after `--`, never parsed back into options. */
	async search(query: string): Promise<EngineResult<SearchReport>> {
		if (typeof query !== 'string') return { ok: false, error: 'query must be a string' };
		const outcome = await this.collect(['search', '--json', '--limit', '20', '--', query]);
		return this.finish(outcome, 'search', this.readTimeoutMs, (o) => parseSearch(o.stdout, o.stderrTail));
	}

	/** Locate resolves one library path to the file the OS may open; it opens nothing itself. */
	async locate(path: string): Promise<EngineResult<LocateReport>> {
		if (typeof path !== 'string') return { ok: false, error: 'path must be a string' };
		const outcome = await this.collect(['locate', '--json', '--', path]);
		return this.finish(outcome, 'locate', this.readTimeoutMs, (o) => parseLocate(o.stdout, o.stderrTail));
	}

	/** Add OCRs and embeds one file: OCR is fast, the local model is not, so it gets its own
	 * killable child (cancel from the page kills the child; the queue is main's business). */
	async add(file: string): Promise<EngineResult<AddReport>> {
		if (typeof file !== 'string') return { ok: false, error: 'file must be a string' };
		const { file: exe, baseArgs } = this.resolve();
		const child = this.spawn.call(exe, [...baseArgs, 'add', '--json', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
		this.addChild = child;
		try {
			return await this.runChild(child, 'add', this.addTimeoutMs, (o) => parseAdd(o.stdout, o.stderrTail));
		} finally {
			if (this.addChild === child) this.addChild = null;
		}
	}

	cancelAdd(): boolean {
		const child = this.addChild;
		if (child === null) return false;
		child.kill('SIGKILL');
		return true;
	}

	async dryRun(): Promise<EngineResult<OrganizeReport>> {
		const outcome = await this.collect(['organize', '--dry-run', '--json'], undefined, this.dryRunTimeoutMs);
		return this.finish(outcome, 'organize --dry-run', this.dryRunTimeoutMs, (o) => parseOrganize(o.stdout, o.stderrTail));
	}

	async apply(): Promise<EngineResult<OrganizeReport>> {
		const outcome = await this.collect(['organize', '--apply', '--json'], undefined, this.applyTimeoutMs);
		return this.finish(outcome, 'organize --apply', this.applyTimeoutMs, (o) => parseOrganize(o.stdout, o.stderrTail));
	}

	async ask(question: string): Promise<EngineResult<AskReport>> {
		if (typeof question !== 'string') return { ok: false, error: 'question must be a string' };
		const { file, baseArgs } = this.resolve();
		const child = this.spawn.call(file, [...baseArgs, 'ask', '--json', '--', question], { stdio: ['ignore', 'pipe', 'pipe'] });
		this.askChild = child;
		try {
			return await this.runChild(child, 'ask', this.askTimeoutMs, (o) => parseAsk(o.stdout, o.stderrTail));
		} finally {
			if (this.askChild === child) this.askChild = null;
		}
	}

	cancelAsk(): boolean {
		const child = this.askChild;
		if (child === null) return false;
		child.kill('SIGKILL');
		return true;
	}

	/** A child the page can cancel or that may hit its time budget: identical collection code,
	 * only the timeout and the parser differ. */
	private async runChild<T>(
		child: EngineProcess,
		call: string,
		timeoutMs: number,
		parse: (o: EngineOutcome) => Parse<T>,
	): Promise<EngineResult<T>> {
		let stdout = '';
		const stderrTail: string[] = [];
		let exitCode: number | null = null;

		if (child.stdout) child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
		if (child.stderr) {
			child.stderr.on('data', (chunk: unknown) => {
				for (const line of String(chunk).split('\n')) {
					if (line !== '') stderrTail.push(line);
					if (stderrTail.length > 8) stderrTail.shift();
				}
			});
		}
		child.once('exit', (code: number | null) => { exitCode = code; });

		const closed = new Promise<void>((resolve) => {
			child.once('close', () => resolve());
			child.once('error', () => resolve());
		});

		const outcome: EngineOutcome = { stdout, stderrTail, exitCode, timedOut: false };
		// Parse as data flows out; a kill flips the flag and the report is replaced by the timeout
		// message, so half a JSON document is never shown.
		const race = await Promise.race([
			closed.then(() => 'closed' as const),
			delay(timeoutMs).then(() => 'timeout' as const),
		]);
		if (race === 'timeout') {
			child.kill('SIGKILL');
			await closed;
			return { ok: false, error: `${call} timed out after ${minutes(timeoutMs)} and was stopped` };
		}
		return this.parse(parse(outcome));
	}
}