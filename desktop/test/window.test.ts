import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WindowController } from '../src/window.ts';

class FakeWindow {
	visible = false;
	isVisible(): boolean { return this.visible; }
	hide(): void { this.visible = false; }
	show(): void { this.visible = true; }
}

class FakeDock {
	hidden = false;
	hide(): void { this.hidden = true; }
	show(): void { this.hidden = false; }
}

test('open creates and shows one window', () => {
	const dock = new FakeDock();
	const created: FakeWindow[] = [];
	const ctl = new WindowController(() => {
		const win = new FakeWindow();
		created.push(win);
		return win;
	}, dock);
	ctl.open();
	ctl.open();
	assert.equal(created.length, 1);
});

test('closing hides and hides dock', () => {
	const dock = new FakeDock();
	const created: FakeWindow[] = [];
	const ctl = new WindowController(() => {
		const win = new FakeWindow();
		created.push(win);
		return win;
	}, dock);
	ctl.open();
	let prevented = false;
	ctl.handleClose({ preventDefault: () => (prevented = true) });
	assert.equal(prevented, true);
	assert.equal(created[0]?.visible, false);
	assert.equal(dock.hidden, true);
});

test('quitting does not prevent close', () => {
	const dock = new FakeDock();
	const created: FakeWindow[] = [];
	const ctl = new WindowController(() => {
		const win = new FakeWindow();
		created.push(win);
		return win;
	}, dock);
	ctl.open();
	ctl.beginQuitting();
	let prevented = false;
	ctl.handleClose({ preventDefault: () => (prevented = true) });
	assert.equal(prevented, false);
});