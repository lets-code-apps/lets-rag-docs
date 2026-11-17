// Long jobs are single-flight: ask and `organize --apply` must not overlap the LLM or Qdrant writes
// (local concurrency 1). Reads stay available. `apply` additionally requires a fresh successful
// dry-run and no filing save since that dry-run, so a stale preview cannot be applied.

import type { OrganizeReport } from './reports.ts';

export type JobState = {
	askBusy: boolean;
	applyBusy: boolean;
	dryRunReady: boolean;
	dryRunReport: OrganizeReport | null;
	saveSinceDryRun: boolean;
};

export class Jobs {
	private state: JobState = {
		askBusy: false,
		applyBusy: false,
		dryRunReady: false,
		dryRunReport: null,
		saveSinceDryRun: false,
	};

	getState(): JobState {
		return { ...this.state, dryRunReport: this.state.dryRunReport };
	}

	tryBeginAsk(): boolean {
		if (this.state.askBusy || this.state.applyBusy) return false;
		this.state.askBusy = true;
		return true;
	}

	endAsk(): void {
		this.state.askBusy = false;
	}

	tryBeginApply(): boolean {
		if (this.state.askBusy || this.state.applyBusy) return false;
		if (!this.state.dryRunReady || this.state.saveSinceDryRun) return false;
		this.state.applyBusy = true;
		return true;
	}

	endApply(): void {
		this.state.applyBusy = false;
	}

	recordDryRun(report: OrganizeReport | null): void {
		this.state.dryRunReady = report !== null;
		this.state.dryRunReport = report;
		this.state.saveSinceDryRun = false;
	}

	recordSave(): void {
		if (this.state.dryRunReady) this.state.saveSinceDryRun = true;
	}

	applyReason(): string | null {
		if (this.state.askBusy || this.state.applyBusy) return 'another long job is running';
		if (!this.state.dryRunReady) return 'run a dry-run first';
		if (this.state.saveSinceDryRun) return 'run a fresh dry-run after saving filing lists';
		return null;
	}
}