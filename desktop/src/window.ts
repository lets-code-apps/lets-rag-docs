// Window policy: closing the window hides it; only an explicit Quit ends the app. This holds the
// small state (has the window been created, are we quitting?) so it can be tested without a real
// Electron BrowserWindow or the macOS dock.

export interface WindowHandle {
	isVisible(): boolean;
	hide(): void;
	show(): void;
}

export interface Dock {
	hide(): void;
	show(): void;
}

export interface CloseEvent {
	preventDefault(): void;
}

export class WindowController {
	private handle: WindowHandle | null = null;
	private quitting = false;
	private readonly createWindow: () => WindowHandle;
	private readonly dock: Dock;

	constructor(createWindow: () => WindowHandle, dock: Dock) {
		this.createWindow = createWindow;
		this.dock = dock;
	}

	open(): void {
		if (this.handle === null) this.handle = this.createWindow();
		this.handle.show();
		this.dock.show();
	}

	beginQuitting(): void {
		this.quitting = true;
	}

	handleClose(event: CloseEvent): void {
		if (this.quitting) return;
		event.preventDefault();
		this.handle?.hide();
		if (this.handle !== null && !this.handle.isVisible()) this.dock.hide();
	}

	handleWindowAllClosed(): void {
		// Intentionally empty: the app can live with no visible window.
	}
}