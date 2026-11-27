// A `model pull` is single-flight: only one download may run at a time, and the page reads its
// progress without re-parsing the engine's lines. This class owns the shared state the main process
// updates as the engine streams NDJSON lines, and that `modelPullStatus` reads back. It makes no
// network call and spawns nothing: engine.ts feeds `observe` with each normalised line and calls
// `begin`/`end` around the child's lifetime.

import { pullProgress, type PullLine } from './setup.ts';

// What `modelPullStatus` answers the page. A fresh (never begun) job reads all-zero and `running:false`.
export type PullStatus = {
	running: boolean;
	model: string;
	done: number;
	gb: number;
	pct: number;
	stage: string;
	success: boolean;
	error: string | null;
	finished: boolean;
};

const FRESH: PullStatus = {
	running: false,
	model: '',
	done: 0,
	gb: 0,
	pct: 0,
	stage: '',
	success: false,
	error: null,
	finished: false,
};

export class PullJob {
	private status: PullStatus = { ...FRESH };

	// Reserve the single slot. Returns false (and changes nothing) if a download is already running:
	// engine.ts uses this to refuse a second `model pull` instead of racing two into one `model.toml`.
	begin(model: string): boolean {
		if (this.status.running) return false;
		this.status = { ...FRESH, running: true, model };
		return true;
	}

	// Fold one engine line into the state: remember the stage, capture an error or a success, and, for a
	// `downloading` line, turn the engine's byte counts into the GB/percent the bar paints.
	observe(line: PullLine): void {
		this.status = { ...this.status, stage: line.stage };
		if (line.stage === 'error') this.status = { ...this.status, error: line.text };
		if (line.stage === 'success') this.status = { ...this.status, success: true };
		const progress = pullProgress(this.status.model, line);
		if (progress !== null) {
			this.status = { ...this.status, done: progress.done, gb: progress.gb, pct: progress.pct };
		}
	}

	// Close the slot: the download is no longer running and this job is finished. Whether it succeeded
	// stays in `success` (an error line's text stays in `error`), so the caller reports the outcome after
	// `end` without losing it.
	end(): void {
		this.status = { ...this.status, running: false, finished: true };
	}

	snapshot(): PullStatus {
		return { ...this.status };
	}
}
