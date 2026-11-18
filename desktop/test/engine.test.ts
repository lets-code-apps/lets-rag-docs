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
