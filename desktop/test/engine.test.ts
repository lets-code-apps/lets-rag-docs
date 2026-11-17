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