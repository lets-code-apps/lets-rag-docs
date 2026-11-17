// One-shot engine calls. The desktop never starts a long-lived engine, never reads the config,
// database or documents, and never parses argv supplied by the page: it spawns `lets-rag-docs`
// with fixed argv and reads only stdout/stderr. A real failure has empty stdout and stderr's first
// line; an expected engine state is a JSON report with exit 0.

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import {
	parseAsk,
	parseDocuments,
	parseFilingSave,
	parseFilingShow,
	parseOrganize,
	type AskReport,
	type DocumentsReport,
	type FilingSaveReport,
	type FilingShowReport,
	type OrganizeReport,
	type Parse,
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
};

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class Engine {
	private readonly env: NodeJS.ProcessEnv;
	private readonly repoRoot: string;
	private readonly spawn: SpawnLike;
	private readonly resourcesPath: string | undefined;
	private readonly readTimeoutMs: number;
	private readonly askTimeoutMs: number;
	private askChild: EngineProcess | null = null;

	constructor(
		env: NodeJS.ProcessEnv,
		repoRoot: string,
		spawn: SpawnLike = defaultSpawn,
		readTimeoutMs: number = 10_000,
		askTimeoutMs: number = 6 * 60_000,
		resourcesPath: string | undefined = undefined,
	) {
		this.env = env;
		this.repoRoot = repoRoot;
		this.spawn = spawn;
		this.readTimeoutMs = readTimeoutMs;
		this.askTimeoutMs = askTimeoutMs;
		this.resourcesPath = resourcesPath;
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
				child.kill('SIGKILL');
				await closed;
			}
		} else {
			await closed;
		}

		return { stdout, stderrTail, exitCode };
	}

	private parse<T>(parsed: Parse<T>): EngineResult<T> {
		if (parsed.ok) return { ok: true, value: parsed.value };
		return { ok: false, error: parsed.error };
	}

	async documents(): Promise<EngineResult<DocumentsReport>> {
		const outcome = await this.collect(['documents', '--json']);
		return this.parse(parseDocuments(outcome.stdout, outcome.stderrTail));
	}

	async filingShow(): Promise<EngineResult<FilingShowReport>> {
		const outcome = await this.collect(['filing', 'show', '--json']);
		return this.parse(parseFilingShow(outcome.stdout, outcome.stderrTail));
	}

	async filingSave(draft: unknown, check: boolean): Promise<EngineResult<FilingSaveReport>> {
		if (typeof draft !== 'object' || draft === null) return { ok: false, error: 'draft must be a JSON object' };
		if (!Array.isArray((draft as { folders?: unknown }).folders) || !Array.isArray((draft as { owners?: unknown }).owners)) {
			return { ok: false, error: 'draft must contain folders and owners arrays' };
		}
		const subArgs = check ? ['filing', 'save', '--check'] : ['filing', 'save'];
		const outcome = await this.collect(subArgs, `${JSON.stringify(draft)}\n`);
		return this.parse(parseFilingSave(outcome.stdout, outcome.stderrTail));
	}

	async dryRun(): Promise<EngineResult<OrganizeReport>> {
		const outcome = await this.collect(['organize', '--dry-run', '--json']);
		return this.parse(parseOrganize(outcome.stdout, outcome.stderrTail));
	}

	async apply(): Promise<EngineResult<OrganizeReport>> {
		const outcome = await this.collect(['organize', '--apply', '--json']);
		return this.parse(parseOrganize(outcome.stdout, outcome.stderrTail));
	}

	async ask(question: string): Promise<EngineResult<AskReport>> {
		if (typeof question !== 'string') return { ok: false, error: 'question must be a string' };
		const { file, baseArgs } = this.resolve();
		const child = this.spawn.call(file, [...baseArgs, 'ask', '--json', '--', question], { stdio: ['ignore', 'pipe', 'pipe'] });
		this.askChild = child;
		try {
			return await this.runAskChild(child);
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

	private async runAskChild(child: EngineProcess): Promise<EngineResult<AskReport>> {
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

		const outcome = await Promise.race([
			closed.then(() => 'closed' as const),
			delay(this.askTimeoutMs).then(() => 'timeout' as const),
		]);
		if (outcome === 'timeout') {
			child.kill('SIGKILL');
			await closed;
		}

		return this.parse(parseAsk(stdout, stderrTail));
	}
}