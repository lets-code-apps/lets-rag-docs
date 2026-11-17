// Long jobs are single-flight: ask and `organize --apply` must not overlap the LLM or Qdrant writes
// (local concurrency 1). Reads stay available. `apply` additionally requires a preview the user
// could see: the last report must be a successful dry-run (`mode:"dry_run"`, `status:"ok"`), with
// no filing save and no apply since. Anything else (no database, outdated, an unknown status, an
// apply report) leaves Apply locked.

import type { OrganizeReport } from './reports.ts';

export type JobState = {
	askBusy: boolean;
	applyBusy: boolean;
	dryRunReady: boolean;
	dryRunReport: OrganizeReport | null;
	saveSinceDryRun: boolean;
};

export function isApplicablePreview(report: OrganizeReport | null): boolean {
	return report !== null && report.mode === 'dry_run' && report.status === 'ok';
}

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
		if (this.applyReason() !== null) return false;
		this.state.applyBusy = true;
		return true;
	}

	/** Ends an apply. Whatever happened, the preview it applied is spent: a new dry-run is needed. */
	endApply(): void {
		this.state.applyBusy = false;
		this.state.dryRunReady = false;
		this.state.dryRunReport = null;
	}

	recordDryRun(report: OrganizeReport | null): void {
		this.state.dryRunReady = isApplicablePreview(report);
		this.state.dryRunReport = this.state.dryRunReady ? report : null;
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
