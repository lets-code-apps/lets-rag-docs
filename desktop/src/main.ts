// The RAG Docs desktop: a tray app that shells one-shot to the Rust engine and renders its
// JSON reports. Main owns argv and process spawning; the renderer sends only data. Closing the
// window hides it; Quit/Cmd+Q ends the app. Smoke and screenshots hard-use the fake engine, never
// real documents or config.

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

import { defaultSpawn, Engine, type EngineResult } from './engine.ts';
import { Jobs } from './jobs.ts';
import { IPC } from './ipc.ts';
import { buildTrayMenu, PRODUCT_NAME } from './menu.ts';
import { WindowController } from './window.ts';
import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from './window-policy.ts';

const HERE = import.meta.dirname;
const RENDERER = join(HERE, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(RENDERER).href;
const PRELOAD = join(HERE, 'preload.cjs');
const TRAY_ICON = join(HERE, '..', 'assets', 'menubarTemplate.png');
const APP_ICON = join(HERE, '..', 'assets', 'icon.png');

const engine = new Engine(process.env, join(HERE, '..', '..'), defaultSpawn);
const jobs = new Jobs();

let currentWindow: BrowserWindow | null = null;
let quitInFlight = false;
const ctl = new WindowController(() => makeWindow(), {
	hide: () => app.dock?.hide(),
	show: () => app.dock?.show(),
});
let tray: Tray | undefined;

const fromUs = (senderFrame?: { url?: string } | null): boolean => senderFrame?.url === INDEX_URL;

function toIPC<T>(result: EngineResult<T>): { ok: boolean; report?: T; error?: string } {
	return result.ok ? { ok: true, report: result.value } : { ok: false, error: result.error };
}

function makeWindow(): BrowserWindow {
	const options = windowOptions();
	const browser = new BrowserWindow({
		width: options.width,
		height: options.height,
		minWidth: options.minWidth,
		show: false,
		webPreferences: {
			...options.webPreferences,
			preload: PRELOAD,
		},
	});
	browser.webContents.on('will-navigate', (event: { preventDefault(): void }) => denyNavigation(event));
	browser.webContents.setWindowOpenHandler(() => windowOpenHandler());
	browser.on('close', (event) => ctl.handleClose(event));
	browser.loadFile(RENDERER);
	currentWindow = browser;
	return browser;
}

function makeTray(): Tray {
	const t = new Tray(TRAY_ICON);
	(t as unknown as { setTemplateImage(image: boolean): void }).setTemplateImage(true);
	t.on('right-click', () => t.popUpContextMenu(trayMenu()));
	t.on('click', () => ctl.open());
	return t;
}

function trayMenu(): Menu {
	const template = buildTrayMenu().map((item) => {
		const built: { label: string; enabled: boolean; click?: () => void; accelerator?: string } = {
			label: item.label,
			enabled: item.enabled,
		};
		const action = item.action;
		if (action) built.click = () => runAction(action);
		if (item.accelerator) built.accelerator = item.accelerator;
		return built;
	});
	return Menu.buildFromTemplate(template);
}

function runAction(action: 'openWindow' | 'quit'): void {
	if (action === 'openWindow') ctl.open();
	else if (action === 'quit') app.quit();
}

function registerIpc(): void {
	ipcMain.handle(IPC.documents, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return toIPC(await engine.documents());
	});

	ipcMain.handle(IPC.filingShow, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return toIPC(await engine.filingShow());
	});

	ipcMain.handle(IPC.filingSave, async (event, draft: unknown, check: boolean) => {
		if (!fromUs(event.senderFrame)) return null;
		const result = await engine.filingSave(draft, Boolean(check));
		if (result.ok) jobs.recordSave();
		return toIPC(result);
	});

	ipcMain.handle(IPC.dryRun, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		const result = await engine.dryRun();
		jobs.recordDryRun(result.ok ? result.value : null);
		return toIPC(result);
	});

	ipcMain.handle(IPC.resort, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		if (!jobs.tryBeginApply()) {
			return { ok: false, error: jobs.applyReason() ?? 'not ready' };
		}
		try {
			const result = await engine.apply();
			jobs.recordDryRun(result.ok ? result.value : null);
			return toIPC(result);
		} finally {
			jobs.endApply();
		}
	});

	ipcMain.handle(IPC.ask, async (event, question: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		if (typeof question !== 'string') return { ok: false, error: 'question must be a string' };
		if (!jobs.tryBeginAsk()) return { ok: false, error: 'busy' };
		try {
			const result = await engine.ask(question);
			jobs.endAsk();
			return toIPC(result);
		} catch {
			jobs.endAsk();
			return { ok: false, error: 'ask failed' };
		}
	});

	ipcMain.handle(IPC.cancelAsk, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return { ok: true, cancelled: engine.cancelAsk() };
	});
}

app.on('before-quit', (event) => {
	ctl.beginQuitting();
	if (quitInFlight) return;
	quitInFlight = true;
	event.preventDefault();
	app.quit();
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => ctl.open());
	void app.whenReady().then(boot);
}

function boot(): void {
	registerIpc();
	if (process.env.RAG_DOCS_SMOKE === '1') {
		void runSmoke();
		return;
	}
	if (process.env.RAG_DOCS_SHOTS === '1') {
		void runShots();
		return;
	}
	tray = makeTray();
	if (!app.isPackaged) {
		app.dock?.hide();
		void app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });
		void app.dock?.setIcon(APP_ICON);
	}
	app.on('window-all-closed', () => ctl.handleWindowAllClosed());

	if (process.env.RAG_DOCS_SMOKE === '1') void runSmoke();
	if (process.env.RAG_DOCS_SHOTS === '1') void runShots();
}

function smokeScript(): string {
	return String.raw`
(async () => {
  const api = window.ragDocs;
  const docs = await api.documents();
  const filing = await api.filing();
  const dry = await api.dryRun();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const text = document.body.textContent || '';
  return {
    docsOk: docs && docs.ok === true,
    filingOk: filing && filing.ok === true,
    dryOk: dry && dry.ok === true,
    docsText: document.getElementById('libraryRows').textContent.length,
    filingText: document.getElementById('filingRows').textContent.length,
    text,
  };
})()
`;
}

async function runSmoke(): Promise<void> {
	const browser = makeWindow();
	const deadline = setTimeout(() => {
		console.error('SMOKE FAIL: timed out after 10s');
		app.exit(1);
	}, 10000);
	try {
		await new Promise<void>((resolve) => browser.webContents.once('did-finish-load', resolve));
		const ok = await browser.webContents.executeJavaScript(smokeScript(), true);
		const title = browser.getTitle();
		const loadedOwnFile = isOwnFile(browser.webContents.getURL(), INDEX_URL);
		if (loadedOwnFile && title === PRODUCT_NAME && ok.docsOk && ok.filingOk && ok.dryOk && ok.docsText > 0 && ok.filingText > 0) {
			console.error(`SMOKE OK: loaded own file, docs rows ${ok.docsText}, filing rows ${ok.filingText}`);
			clearTimeout(deadline);
		app.exit(0);
			return;
		}
		console.error(`SMOKE FAIL: url=${browser.webContents.getURL()} title=${title} checks=${JSON.stringify(ok)}`);
	} catch (error: unknown) {
		console.error(`SMOKE FAIL: ${String(error)}`);
	}
	clearTimeout(deadline);
	app.exit(1);
}

async function runShots(): Promise<void> {
	const browser = makeWindow();
	const deadline = setTimeout(() => {
		console.error('SHOTS FAIL: timed out after 60s');
		app.exit(1);
	}, 60000);
	await new Promise<void>((resolve) => browser.webContents.once('did-finish-load', resolve));
	browser.show();
	const names = ['ask-light', 'ask-dark', 'filing-default-light', 'filing-default-dark', 'filing-error-light', 'filing-error-dark', 'filing-notice-light', 'filing-notice-dark'];
	try {
	for (const name of names) {
		if (name.includes('dark')) nativeTheme.themeSource = 'dark';
		else nativeTheme.themeSource = 'light';
		if (name.startsWith('ask')) {
			await browser.webContents.executeJavaScript(String.raw`
(async () => {
  document.getElementById('askView').click();
  await new Promise((resolve) => setTimeout(resolve, 350));
})()
`, true);
		} else if (name.startsWith('filing-error')) {
			await browser.webContents.executeJavaScript(String.raw`
(async () => {
  document.getElementById('filingView').click();
  document.getElementById('saveDraftButton').click();
  await new Promise((resolve) => setTimeout(resolve, 350));
})()
`, true);
		} else if (name.startsWith('filing')) {
			await browser.webContents.executeJavaScript(String.raw`
(async () => {
  document.getElementById('filingView').click();
  await new Promise((resolve) => setTimeout(resolve, 350));
})()
`, true);
		}
		if (name === 'filing-notice-light' || name === 'filing-notice-dark') browser.setSize(360, 480);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const image = await browser.webContents.capturePage();
		const imageBuffer = (image as unknown as { toPNG(): Buffer }).toPNG();
		mkdirSync(join(HERE, '..', 'screenshots'), { recursive: true });
		writeFileSync(join(HERE, '..', 'screenshots', `${name}.png`), imageBuffer);
	}
	} catch (error: unknown) {
		console.error(`SHOTS FAIL: ${String(error)}`);
		clearTimeout(deadline);
		app.exit(1);
		return;
	}
	console.error('SHOTS OK');
	clearTimeout(deadline);
	app.exit(0);
}

// Normal launch stays tray-resident: no window appears until the tray opens one.
if (process.env.RAG_DOCS_START_WINDOW === '1') {
	void app.whenReady().then(() => ctl.open());
}