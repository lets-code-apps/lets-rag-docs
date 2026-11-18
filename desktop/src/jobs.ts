// Long jobs are single-flight: ask and `organize --apply` must not overlap the LLM or Qdrant writes
// (local concurrency 1). Reads stay available. `apply` additionally requires a preview the user
// could see: the last report must be a successful dry-run (`mode:"dry_run"`, `status:"ok"`), with
// no filing save and no apply since. Anything else (no database, outdated, an unknown status, an
// apply report) leaves Apply locked. Saves are counted in a generation: a dry-run that started
// before a save began describes the old lists, so it is ignored even if it finishes afterwards.

import type { OrganizeReport } from './reports.ts';

export type JobState = {
	askBusy: boolean;
	addBusy: boolean;
	applyBusy: boolean;
	dryRunReady: boolean;
	dryRunReport: OrganizeReport | null;
	saveSinceDryRun: boolean;
	saving: number;
	saveGeneration: number;
};

export function isApplicablePreview(report: OrganizeReport | null): boolean {
	return report !== null && report.mode === 'dry_run' && report.status === 'ok';
}

export class Jobs {
	private state: JobState = {
		askBusy: false,
		addBusy: false,
		applyBusy: false,
		dryRunReady: false,
		dryRunReport: null,
		saveSinceDryRun: false,
		saving: 0,
		saveGeneration: 0,
	};

	getState(): JobState {
		return { ...this.state, dryRunReport: this.state.dryRunReport };
	}

	tryBeginAsk(): boolean {
		if (this.state.askBusy || this.state.applyBusy || this.state.addBusy) return false;
		this.state.askBusy = true;
		return true;
	}

	endAsk(): void {
		this.state.askBusy = false;
	}

	/** Adding runs OCR + one embedding per document through the local model, so it is single-flight
	 * like ask and apply. */
	tryBeginAdd(): boolean {
		if (this.state.askBusy || this.state.applyBusy || this.state.addBusy) return false;
		this.state.addBusy = true;
		return true;
	}

	endAdd(): void {
		this.state.addBusy = false;
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

	/** Call when a dry-run starts; pass the result to `recordDryRun` with this token. */
	beginDryRun(): number {
		return this.state.saveGeneration;
	}

	/** Returns false (and changes nothing) when a save began after this dry-run started. */
	recordDryRun(report: OrganizeReport | null, startedAt: number = this.state.saveGeneration): boolean {
		if (startedAt !== this.state.saveGeneration || this.state.saving > 0) return false;
		this.state.dryRunReady = isApplicablePreview(report);
		this.state.dryRunReport = this.state.dryRunReady ? report : null;
		this.state.saveSinceDryRun = false;
		return true;
	}

	/** A save that may write the lists: from its start, every earlier preview is stale. */
	beginSave(): void {
		this.state.saving += 1;
		this.state.saveGeneration += 1;
		this.recordSave();
	}

	endSave(): void {
		this.state.saving = Math.max(0, this.state.saving - 1);
	}

	recordSave(): void {
		if (this.state.dryRunReady) this.state.saveSinceDryRun = true;
	}

	applyReason(): string | null {
		if (this.state.askBusy || this.state.applyBusy || this.state.addBusy) return 'another long job is running';
		if (this.state.saving > 0) return 'a filing save is still running';
		if (!this.state.dryRunReady) return 'run a dry-run first';
		if (this.state.saveSinceDryRun) return 'run a fresh dry-run after saving filing lists';
		return null;
	}

	/** Why an add cannot start now: the LLM and Qdrant writes are single-flight, and a save
	 * mid-flight would make the new row's folder lists stale. */
	addReason(): string | null {
		if (this.state.askBusy || this.state.applyBusy || this.state.addBusy) return 'another long job is running';
		if (this.state.saving > 0) return 'a filing save is still running';
		return null;
	}
}
