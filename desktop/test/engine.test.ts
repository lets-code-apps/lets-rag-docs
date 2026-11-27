import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { Engine, type EngineProcess } from '../src/engine.ts';

class FakeChild extends EventEmitter {
	readonly stdin: NodeJS.WritableStream | null = null;
	readonly stdout: NodeJS.ReadableStream | null = null;
	readonly stderr: NodeJS.ReadableStream | null = null;
	killed = false;
	kill(): void {
		this.killed = true;
		this.emit('close');
	}
}

test('ask argv is exactly ask --json -- <question>', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0, 100);
	await engine.ask('-x');
	assert.deepEqual(recorded, [['ask', '--json', '--', '-x']]);
});

test('engine timeout kills the ask child', async () => {
	const children: FakeChild[] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			void args;
			const child = new FakeChild();
			children.push(child);
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0, 5);
	const result = await engine.ask('slow');
	assert.ok(!result.ok);
	assert.equal(children[0]?.killed, true);
});
/** A child that prints `stdout` and closes after `ms`; records argv and stdin. */
function slowSpawn(ms: number, stdout: string, seen: { args: string[][]; stdin: string[]; killed?: boolean }) {
	return {
		call(file: string, args: string[]) {
			void file;
			seen.args.push(args);
			const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
			const out = new EventEmitter();
			child.stdout = out;
			child.stderr = new EventEmitter();
			child.stdin = { write: (text: string) => seen.stdin.push(text), end: () => {} };
			const timer = setTimeout(() => {
				out.emit('data', stdout);
				child.emit('exit', 0);
				child.emit('close');
			}, ms);
			child.kill = () => {
				seen.killed = true;
				clearTimeout(timer);
				child.emit('close');
			};
			return child as unknown as EngineProcess;
		},
	};
}

const APPLY = JSON.stringify({ version: 1, mode: 'apply', status: 'ok', items: [], counts: { moved: 0 } });

test('apply gets its own long budget, not the read timeout', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
	// read budget 10 ms, apply budget 1 s: a 50 ms apply must finish, not be killed
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(50, APPLY, seen), 10, 100, undefined, 10, 1000);
	const result = await engine.apply();
	assert.ok(result.ok);
	assert.equal(seen.killed, false);
	assert.deepEqual(seen.args, [['organize', '--apply', '--json']]);
});

test('an apply over its budget is stopped and reported as a timeout', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(500, APPLY, seen), 10, 100, undefined, 10, 20);
	const result = await engine.apply();
	assert.equal(seen.killed, true);
	assert.ok(!result.ok);
	assert.match(result.error, /organize --apply timed out/);
});

test('a filing draft goes on stdin, never into argv', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
	const save = JSON.stringify({ version: 1, ok: true, saved: false, folders: ['A b'], owners: [], errors: [] });
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(1, save, seen), 1000);
	const result = await engine.filingSave({ folders: ['A b'], owners: [] }, true);
	assert.ok(result.ok);
	assert.deepEqual(seen.args, [['filing', 'save', '--check']]);
	assert.deepEqual(seen.stdin, ['{"folders":["A b"],"owners":[]}\n']);
});

// ---- step 3: search, locate, add (add is a killable child like ask) ----

test('search argv is exactly search --json --limit 20 -- <query>', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0);
	await engine.search('-drop table');
	assert.deepEqual(recorded, [['search', '--json', '--limit', '20', '--', '-drop table']]);
});

test('locate argv is exactly locate --json -- <path>', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0);
	await engine.locate('--weird name.pdf');
	assert.deepEqual(recorded, [['locate', '--json', '--', '--weird name.pdf']]);
});

test('add argv is exactly add --json -- <file> and cancelAdd kills the child', async () => {
	const recorded: string[][] = [];
	const children: FakeChild[] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			children.push(child);
			// Never closes on its own: only cancelAdd's kill ends it.
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0, 0, undefined, 0, 0, 1000);
	const running = engine.add('loan.pdf');
	const cancelled = engine.cancelAdd();
	const result = await running;
	assert.deepEqual(recorded, [['add', '--json', '--', 'loan.pdf']]);
	assert.equal(cancelled, true);
	assert.equal(children[0]?.killed, true);
	assert.ok(!result.ok);
});

test('a filing draft rejects a wrong-typed shared_owner or rename before touching the engine', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[] };
	const save = JSON.stringify({ version: 1, ok: true, saved: false, renamed: 0, folders: [], owners: [], errors: [] });
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(1, save, seen), 1000);
	const badOwner = await engine.filingSave({ folders: [], owners: [], shared_owner: 42 }, true);
	assert.ok(!badOwner.ok);
	const badRename = await engine.filingSave({ folders: [], owners: [], renames: [{ list: 'folders', from: 'A' }] }, true);
	assert.ok(!badRename.ok);
	assert.equal(seen.args.length, 0, 'no engine call for an invalid draft');
	// A well-formed rename is forwarded verbatim on stdin.
	const good = await engine.filingSave({ folders: [], owners: [], renames: [{ list: 'owners', from: 'Car', to: 'Vehicles' }] }, true);
	assert.ok(good.ok);
	assert.deepEqual(seen.args, [['filing', 'save', '--check']]);
	assert.match(seen.stdin[0], /"renames":\[\{"list":"owners","from":"Car","to":"Vehicles"\}\]/);
});

// ---- review round 1: runChild must assemble the outcome AFTER close ----

test('ask parses JSON that reaches stdout asynchronously', async () => {
  const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
  const askJson = JSON.stringify({ version: 1, answer: 'Blue.', sources: [{ source: 'car loan', file: 'home/car-loan-invoice.pdf.vision.txt', chunk: 2, page: 4, score: 0.5 }] });
  const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(10, askJson, seen), 1000, 1000);
  const result = await engine.ask('when is it paid off?');
  assert.ok(result.ok);
  assert.equal(result.value.answer, 'Blue.');
  assert.equal(result.value.sources[0].page, 4);
  assert.equal(seen.killed, false);
});

test('add parses JSON that reaches stdout asynchronously', async () => {
  const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
  const addJson = JSON.stringify({ version: 1, status: 'added', source: 'lamp', file: 'lamp.pdf', type: 'invoice', date: null, chunks: 3, duplicate_of: null });
  // args: env, repo, spawn, read, ask, resources, dryRun, apply, add timeouts
  const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(10, addJson, seen), 1000, 1000, undefined, 1000, 1000, 1000);
  const result = await engine.add('lamp.pdf');
  assert.ok(result.ok);
  assert.equal(result.value.status, 'added');
  assert.equal(result.value.file, 'lamp.pdf');
  assert.equal(seen.killed, false);
});

test('status argv is exactly status --json', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0, 100);
	await engine.status();
	assert.deepEqual(recorded, [['status', '--json']]);
});

test('a status call is a read: its own budget kills the child, and no parse of half a report', async () => {
	const children: FakeChild[] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			void args;
			const child = new FakeChild();
			children.push(child);
			return child as unknown as EngineProcess;
		},
	};
	// read budget 5 ms: the child never speaks, so the call must die at the budget.
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 5, 100);
	const result = await engine.status();
	assert.ok(!result.ok);
	assert.match(result.error, /timed out/);
	assert.equal(children[0]?.killed, true);
});

test('status parses the engine report through the real collect path', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[] };
	const spawn = slowSpawn(0, JSON.stringify({ version: 1, model: { reachable: false }, last_sync: null }), seen);
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0, 100);
	const result = await engine.status();
	assert.ok(result.ok);
	assert.equal(result.value.model.reachable, false);
	assert.equal(result.value.last_sync, null);
});

// ---- first-run onboarding (LET-136): setup show/save and model detect/save/pull ----

test('setup show argv is exactly setup show --json', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0);
	await engine.setupShow();
	assert.deepEqual(recorded, [['setup', 'show', '--json']]);
});

test('the setup draft travels on stdin like a filing draft; --check is the only difference', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
	const show = JSON.stringify({ version: 1, ok: true, saved: true, errors: [] });
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(1, show, seen), 1000);
	const result = await engine.setupSave({ library_dir: '~/Documents/library', watch_folders: ['~/Downloads'] }, false);
	assert.ok(result.ok);
	assert.deepEqual(seen.args, [['setup', 'save']]);
	assert.deepEqual(seen.stdin, ['{"library_dir":"~/Documents/library","watch_folders":["~/Downloads"]}\n']);
	await engine.setupSave({ library_dir: '~/L', watch_folders: [] }, true);
	assert.deepEqual(seen.args[1], ['setup', 'save', '--check']);
});

test('setup save refuses a wrong-typed draft before touching the engine', async () => {
	const seen = { args: [] as string[][], stdin: [] as string[], killed: false };
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', slowSpawn(1, '{}', seen), 1000);
	const noLibrary = await engine.setupSave({ watch_folders: [] }, true);
	const folderNotString = await engine.setupSave({ library_dir: '~/L', watch_folders: [42] }, true);
	assert.ok(!noLibrary.ok);
	assert.ok(!folderNotString.ok);
	assert.equal(seen.args.length, 0, 'no engine call for an invalid draft');
});

test('model detect argv is closed: model detect --json, --url only when typed', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0);
	await engine.modelDetect();
	await engine.modelDetect('http://127.0.0.1:11434');
	assert.deepEqual(recorded, [['model', 'detect', '--json'], ['model', 'detect', '--json', '--url=http://127.0.0.1:11434']]);
	// A value that cannot be an address (a flag) never spawns anything.
	const before = recorded.length;
	const refused = await engine.modelDetect('--evil');
	assert.ok(!refused.ok);
	assert.equal(recorded.length, before, 'a bad --url is refused in-process');
});

test('model save argv is the three validated value-flags', async () => {
	const recorded: string[][] = [];
	const spawn = {
		call(file: string, args: string[]) {
			void file;
			recorded.push(args);
			const child = new FakeChild();
			queueMicrotask(() => child.emit('close'));
			return child as unknown as EngineProcess;
		},
	};
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', spawn, 0);
	await engine.modelSave('ollama', 'http://127.0.0.1:11434', 'qwen3:8b');
	assert.deepEqual(recorded, [['model', 'save', '--json', '--runtime=ollama', '--url=http://127.0.0.1:11434', '--model=qwen3:8b']]);
	const bad = await engine.modelSave('cloud', 'http://127.0.0.1:11434', 'qwen3:8b');
	assert.ok(!bad.ok, 'only the engine runtime words reach argv');
});

/** A child that streams NDJSON over `chunks` then closes; records argv and whether it was killed. */
function pullSpawn(chunks: string[], seen: { args: string[][]; killed: boolean }, opts: { delayMs: number; hold?: boolean }) {
	return {
		call(file: string, args: string[]) {
			void file;
			seen.args.push(args);
			const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
			const out = new EventEmitter();
			child.stdout = out;
			child.stderr = new EventEmitter();
			if (!opts.hold) {
				setTimeout(() => {
					for (const c of chunks) out.emit('data', c);
					child.emit('exit', 0);
					child.emit('close');
				}, opts.delayMs);
			}
			child.kill = () => {
				seen.killed = true;
				child.emit('close');
			};
			return child as unknown as EngineProcess;
		},
	};
}

test('model pull streams the NDJSON, updates the bar live, and reports success', async () => {
	const seen = { args: [] as string[][], killed: false };
	// A chunk boundary lands mid-line: the buffer tail must rejoin it before parsing.
	const chunks = ['{"stage":"pulling manifest"}\n{"stage":"down', 'loading","total":2048,"completed":1024}\n', '{"stage":"success"}\n'];
	// env, repo, spawn, read, ask, resources, dryRun, apply, add, pull
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', pullSpawn(chunks, seen, { delayMs: 2 }), 0, 100, undefined, 1000, 1000, 1000, 1000);
	const result = await engine.modelPull('qwen3:8b');
	assert.ok(result.ok);
	assert.equal(result.value.success, true);
	assert.equal(result.value.error, null);
	assert.deepEqual(seen.args, [['model', 'pull', '--json', '--', 'qwen3:8b']]);
	const status = engine.modelPullStatus();
	assert.equal(status.model, 'qwen3:8b');
	assert.equal(status.stage, 'success');
	assert.equal(status.success, true);
	assert.equal(status.pct, 50, '1024/2048 of the way through the download');
	assert.equal(status.running, false, 'the slot is closed once the pull is over');
});

test('cancelPull kills the download child and the pull reports it did not finish', async () => {
	const seen = { args: [] as string[][], killed: false };
	// hold: the child never closes on its own, so only cancelPull ends it.
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', pullSpawn([], seen, { delayMs: 0, hold: true }), 0, 100, undefined, 1000, 1000, 1000, 1000);
	const running = engine.modelPull('qwen3:14b');
	const cancelled = engine.cancelPull();
	const result = await running;
	assert.equal(cancelled, true);
	assert.equal(seen.killed, true);
	assert.ok(result.ok, 'a cancelled stream is still a result, not a crash');
	assert.equal(result.value.success, false);
	assert.match(result.value.error ?? '', /ended|finish/i);
});

test('a second model pull is refused while one runs (single flight)', async () => {
	const seen = { args: [] as string[][], killed: false };
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', pullSpawn([], seen, { delayMs: 0, hold: true }), 0, 100, undefined, 1000, 1000, 1000, 1000);
	void engine.modelPull('qwen3:8b'); // starts the single slot and awaits on the held child
	const second = await engine.modelPull('qwen3:4b');
	assert.ok(!second.ok);
	assert.match(second.error, /already running/);
	assert.equal(seen.args.length, 1, 'the refused pull never spawns a child');
	engine.cancelPull();
});

test('a pull whose stream never reaches success is a failed pull, not an engine error', async () => {
	const seen = { args: [] as string[][], killed: false };
	// The server reports only a downloading line, then closes: no `success` stage.
	const chunks = ['{"stage":"downloading","total":2048,"completed":1}\n'];
	const engine = new Engine({ RAG_DOCS_ENGINE_PATH: 'fake' }, '/repo', pullSpawn(chunks, seen, { delayMs: 2 }), 0, 100, undefined, 1000, 1000, 1000, 1000);
	const result = await engine.modelPull('qwen3:8b');
	assert.ok(result.ok);
	assert.equal(result.value.success, false, 'a body that stopped early is not a finished model');
});
