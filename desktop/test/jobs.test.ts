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
	assert.equal(jobs.tryBeginApply(), true);
	jobs.endApply();
	jobs.recordSave();
	assert.equal(jobs.tryBeginApply(), false);
	assert.equal(jobs.applyReason(), 'run a fresh dry-run after saving filing lists');
});