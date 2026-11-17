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
function slowSpawn(ms: number, stdout: string, seen: { args: string[][]; stdin: string[]; killed: boolean }) {
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
