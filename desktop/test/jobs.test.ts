import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Jobs } from '../src/jobs.ts';
import type { OrganizeReport } from '../src/reports.ts';

const report: OrganizeReport = { version: 1, mode: 'dry_run', status: 'ok', items: [], counts: { would_copy: 1 } };

test('second long job is refused', () => {
	const jobs = new Jobs();
	assert.equal(jobs.tryBeginAsk(), true);
	assert.equal(jobs.tryBeginApply(), false);
	jobs.endAsk();
	assert.equal(jobs.tryBeginApply(), false, 'no dry-run yet');
});

test('cancel releases ask', () => {
	const jobs = new Jobs();
	assert.equal(jobs.tryBeginAsk(), true);
	jobs.endAsk();
	assert.equal(jobs.tryBeginAsk(), true);
});

test('apply needs fresh dry-run', () => {
	const jobs = new Jobs();
	jobs.recordDryRun(report);
	jobs.recordSave();
	assert.equal(jobs.tryBeginApply(), false);
	assert.equal(jobs.applyReason(), 'run a fresh dry-run after saving filing lists');
});
test('only a successful dry-run unlocks apply', () => {
	for (const bad of [
		{ ...report, status: 'outdated' },
		{ ...report, status: 'no_database' },
		{ ...report, status: 'something_new' },
		{ ...report, mode: 'apply' },
	]) {
		const jobs = new Jobs();
		jobs.recordDryRun(bad);
		assert.equal(jobs.tryBeginApply(), false, JSON.stringify(bad));
		assert.equal(jobs.applyReason(), 'run a dry-run first');
	}
});

test('an apply spends its preview', () => {
	const jobs = new Jobs();
	jobs.recordDryRun(report);
	assert.equal(jobs.tryBeginApply(), true);
	assert.equal(jobs.tryBeginAsk(), false, 'ask waits while apply runs');
	jobs.endApply();
	assert.equal(jobs.tryBeginApply(), false, 'a second apply needs a new dry-run');
});

test('a dry-run that started before a save cannot arm apply when it finishes after it', () => {
	const jobs = new Jobs();
	const startedAt = jobs.beginDryRun(); // dry-run of the old lists starts
	jobs.beginSave(); // the user saves new lists while it runs
	jobs.endSave();
	assert.equal(jobs.recordDryRun(report, startedAt), false, 'the stale preview is refused');
	assert.equal(jobs.tryBeginApply(), false);
	const fresh = jobs.beginDryRun(); // a dry-run of the new lists
	assert.equal(jobs.recordDryRun(report, fresh), true);
	assert.equal(jobs.tryBeginApply(), true);
});

test('apply waits while a save is running, and a save disarms an earlier preview', () => {
	const jobs = new Jobs();
	jobs.recordDryRun(report, jobs.beginDryRun());
	jobs.beginSave();
	assert.equal(jobs.tryBeginApply(), false);
	assert.equal(jobs.applyReason(), 'a filing save is still running');
	jobs.endSave();
	assert.equal(jobs.tryBeginApply(), false, 'the preview predates the save');
});

// ---- step 3: add is single-flight with ask and apply (LLM + Qdrant concurrency 1) ----

test('add excludes ask and apply, and vice versa', () => {
	const j = new Jobs();
	assert.equal(j.tryBeginAdd(), true);
	assert.equal(j.tryBeginAsk(), false);
	assert.equal(j.tryBeginApply(), false);
	j.endAdd();
	assert.equal(j.tryBeginAsk(), true);
	j.endAsk();
	// reads never gate
	assert.equal(j.tryBeginAdd(), true);
	j.endAdd();
	assert.equal(j.getState().askBusy, false);
});

test('addReason: a running save blocks add (stale lists)', () => {
	const j = new Jobs();
	j.beginSave();
	assert.equal(j.addReason(), 'a filing save is still running');
	j.endSave();
	assert.equal(j.addReason(), null);
});
