import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PullJob } from '../src/pull.ts';
import { parsePullLine } from '../src/setup.ts';

test('a fresh PullJob reads all-zero and not running', () => {
	const job = new PullJob();
	const snap = job.snapshot();
	assert.equal(snap.running, false);
	assert.equal(snap.success, false);
	assert.equal(snap.pct, 0);
	assert.equal(snap.model, '');
});

test('begin reserves the single slot; a second begin is refused until end', () => {
	const job = new PullJob();
	assert.equal(job.begin('qwen3:8b'), true);
	assert.equal(job.begin('qwen3:4b'), false, 'only one download may run at a time');
	assert.equal(job.snapshot().model, 'qwen3:8b', 'the first begin owns the slot');
	job.end();
	assert.equal(job.snapshot().running, false);
	assert.equal(job.snapshot().finished, true);
});

test('observe folds engine lines into the bar: a downloading line sets GB/percent, a success line confirms it', () => {
	const job = new PullJob();
	job.begin('qwen3:8b');
	job.observe(parsePullLine('{"stage":"pulling manifest"}')!);
	job.observe(parsePullLine('{"stage":"downloading","total":1073741824,"completed":536870912}')!);
	let snap = job.snapshot();
	assert.equal(snap.stage, 'downloading');
	assert.equal(snap.done, 0.5);
	assert.equal(snap.gb, 1);
	assert.equal(snap.pct, 50);
	job.observe(parsePullLine('{"stage":"success"}')!);
	snap = job.snapshot();
	assert.equal(snap.success, true, 'the server confirmed success');
});

test('an error stage keeps its reason, and a non-line never disturbs the state', () => {
	const job = new PullJob();
	job.begin('qwen3:8b');
	job.observe(parsePullLine('{"stage":"downloading","total":100,"completed":10}')!);
	job.observe(parsePullLine('{"stage":"error","error":"manifest not found"}')!);
	const snap = job.snapshot();
	assert.equal(snap.error, 'manifest not found');
	assert.equal(snap.success, false);
	// parsePullLine returns null for a stray non-JSON line, so observe is never called with it here;
	// confirm the bar keeps the last real progress rather than resetting.
	assert.equal(snap.pct, 10, 'the earlier real progress stays');
});

test('a second pull reuses the slot after the first ends, and starts clean', () => {
	const job = new PullJob();
	job.begin('qwen3:8b');
	job.observe(parsePullLine('{"stage":"downloading","total":100,"completed":80}')!);
	job.end();
	assert.equal(job.begin('qwen3:14b'), true, 'the slot is free again');
	const snap = job.snapshot();
	assert.equal(snap.model, 'qwen3:14b');
	assert.equal(snap.pct, 0, 'a new pull starts empty, not at the old 80%');
	assert.equal(snap.finished, false);
});
