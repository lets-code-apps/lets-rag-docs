// The RAG Docs desktop: a tray app that shells one-shot to the Rust engine and renders its
// JSON reports. Main owns argv and process spawning; the renderer sends only data. Closing the
// window hides it; Quit/Cmd+Q ends the app. Smoke and screenshots drive the real page against the
// fake engine (pinned by the npm scripts), never real documents or config.

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { defaultSpawn, Engine, type EngineResult } from './engine.ts';
import { Jobs } from './jobs.ts';
import { IPC } from './ipc.ts';
import { buildTrayMenu, PRODUCT_NAME } from './menu.ts';
import { WindowController } from './window.ts';
import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from './window-policy.ts';
import { SettingsController, type SettingsHost } from './settings.ts';

const HERE = import.meta.dirname;
const RENDERER = join(HERE, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(RENDERER).href;
const PRELOAD = join(HERE, 'preload.cjs');
// The design's menu-bar template: black on transparent, 18px with an @2x beside it. The
// `Template` suffix plus `setTemplateImage(true)` on the image lets macOS tint it for a light or
// dark menu bar. `setTemplateImage` is a NativeImage method, so the Tray gets the prepared image.
const TRAY_ICON = join(HERE, '..', 'assets', 'menubarTemplate.png');
const APP_ICON = join(HERE, '..', 'assets', 'icon.png');

const engine = new Engine(process.env, join(HERE, '..', '..'), defaultSpawn);
const jobs = new Jobs();

let quitInFlight = false;
const ctl = new WindowController(() => makeWindow(), {
	hide: () => app.dock?.hide(),
	show: () => void app.dock?.show(),
});
let tray: Tray | undefined;

// The app's appearance + open-at-login owner. Built once in boot: the real host reads/writes the
// macOS login item and the app's own settings.json under userData; smoke and shots use a temp file
// and an in-memory login item (so `npm run smoke` never registers a login item on the user's Mac).
let settingsController: SettingsController;
let settingsFile = '';
let settingsTempDir: string | undefined;
let memoryLoginItem: { openAtLogin: boolean } | undefined;

const fromUs = (senderFrame?: { url?: string } | null): boolean => senderFrame?.url === INDEX_URL;

function isRendererNavigation(url: string): boolean {
	try {
		const target = new URL(url);
		const own = new URL(INDEX_URL);
		return target.protocol === own.protocol && target.hostname === own.hostname && target.pathname === own.pathname;
	} catch {
		return false;
	}
}

function toIPC<T>(result: EngineResult<T>): { ok: boolean; report?: T; error?: string } {
	return result.ok ? { ok: true, report: result.value } : { ok: false, error: result.error };
}

/** A thrown error (no engine binary, spawn failure) becomes a result the page can show. */
async function guard<T>(work: () => Promise<T>): Promise<T | { ok: false; error: string }> {
	try {
		return await work();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message.split('\n')[0] ?? 'the engine could not be started' };
	}
}

function makeWindow(): BrowserWindow {
	const options = windowOptions();
	const browser = new BrowserWindow({
		width: options.width,
		height: options.height,
		minWidth: options.minWidth,
		minHeight: options.minHeight,
		titleBarStyle: options.titleBarStyle,
		trafficLightPosition: options.trafficLightPosition,
		title: PRODUCT_NAME,
		show: false,
		webPreferences: {
			...options.webPreferences,
			preload: PRELOAD,
		},
	});
	browser.webContents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
		if (!isRendererNavigation(url)) denyNavigation(event);
	});
	browser.webContents.setWindowOpenHandler(() => windowOpenHandler());
	browser.on('close', (event) => ctl.handleClose(event));
	void browser.loadFile(RENDERER);
	return browser;
}

function makeTray(): Tray {
	const image = nativeImage.createFromPath(TRAY_ICON);
	image.setTemplateImage(true);
	const t = new Tray(image);
	t.setToolTip(PRODUCT_NAME);
	t.on('click', () => ctl.open());
	t.on('right-click', () => t.popUpContextMenu(trayMenu()));
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

function makeSettingsController(): SettingsController {
	// One factory picks the host. Under smoke/shots it never touches the real userData folder or the
	// real login item; `setTheme` still drives the real nativeTheme so "appearance is live" is real.
	const testing = process.env.RAG_DOCS_SMOKE === '1' || process.env.RAG_DOCS_SHOTS === '1';
	if (testing) {
		settingsTempDir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-'));
		settingsFile = join(settingsTempDir, 'settings.json');
		memoryLoginItem = { openAtLogin: false };
		const host: SettingsHost = {
			setTheme: (appearance) => {
				nativeTheme.themeSource = appearance;
			},
			getOpenAtLogin: () => memoryLoginItem?.openAtLogin ?? false,
			setOpenAtLogin: (value) => {
				if (memoryLoginItem) memoryLoginItem.openAtLogin = value;
			},
		};
		return new SettingsController(settingsFile, host);
	}
	settingsFile = join(app.getPath('userData'), 'settings.json');
	const host: SettingsHost = {
		setTheme: (appearance) => {
			nativeTheme.themeSource = appearance;
		},
		getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
		setOpenAtLogin: (value) => {
			app.setLoginItemSettings({ openAtLogin: value });
		},
	};
	return new SettingsController(settingsFile, host);
}

function registerIpc(): void {
	ipcMain.handle(IPC.documents, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => toIPC(await engine.documents()));
	});

	ipcMain.handle(IPC.filingShow, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => toIPC(await engine.filingShow()));
	});

	ipcMain.handle(IPC.filingSave, async (event, draft: unknown, check: boolean) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			if (check) return toIPC(await engine.filingSave(draft, true));
			jobs.beginSave();
			try {
				return toIPC(await engine.filingSave(draft, false));
			} finally {
				jobs.endSave();
			}
		});
	});

	ipcMain.handle(IPC.dryRun, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			const startedAt = jobs.beginDryRun();
			const result = await engine.dryRun();
			// A save that began meanwhile made this preview stale: never show or arm it.
			if (!jobs.recordDryRun(result.ok ? result.value : null, startedAt)) {
				return { ok: false, stale: true, error: 'the lists changed while re-sorting; re-sort again' };
			}
			return toIPC(result);
		});
	});

	// The only way to apply: no arguments, and only after a successful dry-run the user has seen.
	ipcMain.handle(IPC.resort, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		if (!jobs.tryBeginApply()) return { ok: false, error: jobs.applyReason() ?? 'not ready' };
		try {
			return await guard(async () => toIPC(await engine.apply()));
		} finally {
			jobs.endApply();
		}
	});

	ipcMain.handle(IPC.ask, async (event, question: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		if (typeof question !== 'string') return { ok: false, error: 'question must be a string' };
		if (!jobs.tryBeginAsk()) return { ok: false, error: 'busy' };
		try {
			return await guard(async () => toIPC(await engine.ask(question)));
		} finally {
			jobs.endAsk();
		}
	});

	ipcMain.handle(IPC.cancelAsk, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return { ok: true, cancelled: engine.cancelAsk() };
	});

	// Settings cross the same trust boundary: our own page only. `settings` reports the current truth;
	// `setSetting` validates name+value through the controller and answers with the new truth.
	ipcMain.handle(IPC.settings, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return settingsController.payload();
	});

	ipcMain.handle(IPC.setSetting, async (event, name: unknown, value: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		return settingsController.set(name, value);
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
	settingsController = makeSettingsController();
	settingsController.load();
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
	app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion(), version: '' });
	if (!app.isPackaged) app.dock?.setIcon(APP_ICON);
	app.dock?.hide();
	app.on('window-all-closed', () => ctl.handleWindowAllClosed());
	// Normal launch stays tray-resident; `npm start` opens the window right away.
	if (process.env.RAG_DOCS_START_WINDOW === '1') ctl.open();
}

// ---- smoke and screenshots: the real page, driven like a user, against the fake engine ----

/** Page-side helpers: wait until no engine call is in flight, click, type. */
const DRIVER = String.raw`
window.__drive = {
  async settle() {
    const quiet = () => document.body.dataset.pending === '0';
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (quiet()) {
        await new Promise((r) => setTimeout(r, 400));
        if (quiet()) return;
      }
    }
    throw new Error('page never settled');
  },
  find(selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error('missing ' + selector);
    return node;
  },
  row(list, title) {
    const node = [...document.querySelectorAll(list + ' .row')].find((r) => r.querySelector('.row-title')?.textContent === title);
    if (!node) throw new Error('missing row ' + title);
    return node;
  },
  async click(selector) { this.find(selector).click(); await this.settle(); },
  async pick(title) { this.row('#filingRows', title).click(); await this.settle(); },
  async type(selector, text) {
    const input = this.find(selector);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await this.settle();
  },
};
`;

async function drive(browser: BrowserWindow, steps: string): Promise<unknown> {
	return browser.webContents.executeJavaScript(`(async () => { ${DRIVER}; const d = window.__drive; await d.settle(); ${steps} })()`, true);
}

function freshFakeState(): string {
	const dir = mkdtempSync(join(tmpdir(), 'rag-docs-fake-'));
	process.env.FAKE_STATE_FILE = join(dir, 'state.json');
	return dir;
}

async function loaded(browser: BrowserWindow): Promise<void> {
	await new Promise<void>((resolve) => browser.webContents.once('did-finish-load', () => resolve()));
}

async function runSmoke(): Promise<void> {
	const dir = freshFakeState();
	const deadline = setTimeout(() => {
		console.error('SMOKE FAIL: timed out after 30s');
		app.exit(1);
	}, 30000);
	let code = 1;
	try {
		const browser = makeWindow();
		await loaded(browser);
		const result = (await drive(browser, String.raw`
      const libraryRows = document.querySelectorAll('#libraryRows .row').length;
      await d.type('#askInput', 'When is the car loan paid off?');
      await d.click('#askButton');
      const answered = !d.find('#answerBlock').hidden && d.find('#citations').children.length > 0;
      await d.click('[data-section="filing"]');
      const folderRows = document.querySelectorAll('#filingRows .row').length;
      await d.pick('Car');
      await d.type('#nameInput', 'Vehicles');
      await d.click('#saveButton');
      const notice = !d.find('#noticeCard').hidden;
      await d.click('#resortButton');
      const moves = document.querySelectorAll('#moveRows .row').length;
      await d.click('#applyButton');
      const filed = d.find('#noticePill').textContent;
      return { libraryRows, answered, folderRows, notice, moves, filed };
    `		)) as { libraryRows: number; answered: boolean; folderRows: number; notice: boolean; moves: number; filed: string; persisted?: boolean; raceSafe?: boolean; titleWide?: boolean; titleNarrow?: boolean; appearanceLive?: boolean; openAtLoginOk?: boolean };
		// Edit -> save -> reload: the saved list comes back from the engine, not from page memory.
		const reload = loaded(browser);
		browser.reload();
		await reload;
		result.persisted = (await drive(browser, String.raw`
      await d.click('[data-section="filing"]');
      const titles = [...document.querySelectorAll('#filingRows .row-title')].map((n) => n.textContent);
      return titles.includes('Vehicles') && !titles.includes('Car');
    `)) as boolean;
		// Race: save new lists while a slow dry-run of the old ones runs. Its preview must not show,
		// and main must refuse apply.
		process.env.FAKE_DRY_RUN_DELAY_MS = '1500';
		result.raceSafe = (await drive(browser, String.raw`
      await d.pick('Finance');
      await d.type('#nameInput', 'Money');
      await d.click('#saveButton');
      d.find('#resortButton').click();
      await new Promise((r) => setTimeout(r, 300));
      d.row('#filingRows', 'Home').click();
      const input = d.find('#nameInput');
      input.value = 'House';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      d.find('#nameForm').requestSubmit();
      await d.settle();
      const forced = await window.ragDocs.resort();
      return d.find('#movesSection').hidden && /changed while re-sorting/.test(d.find('#filingError').textContent) && forced.ok === false;
    `)) as boolean;
		delete process.env.FAKE_DRY_RUN_DELAY_MS;

		// The app name lives in the shared bar, so it shows on every screen. Check it is centred,
		// clear of the emblem and that nothing scrolls sideways, on ask/filing/settings at 1200px
		// and at the 360px minimum.
		const TITLE_ON = String.raw`
  const check = () => {
    const t = d.find('#appTitle').getBoundingClientRect();
    const e = d.find('.emblem').getBoundingClientRect();
    const w = window.innerWidth;
    return d.find('#appTitle').textContent === 'rag docs'
      && Math.abs((t.left + t.right) / 2 - w / 2) <= 1
      && t.right <= e.left + 1
      && document.documentElement.scrollWidth <= w + 1;
  };
  await d.click('[data-section="ask"]'); const a = check();
  await d.click('[data-section="filing"]'); const f = check();
  await d.click('[data-section="settings"]'); const s = check();
  return a && f && s;
`;
		result.titleWide = (await drive(browser, TITLE_ON)) as boolean;
		browser.setSize(360, 780);
		const reloadNarrow = loaded(browser);
		browser.reload();
		await reloadNarrow;
		result.titleNarrow = (await drive(browser, TITLE_ON)) as boolean;
		browser.setSize(1200, 820);
		const reloadLive = loaded(browser);
		browser.reload();
		await reloadLive;
		// Appearance is live: picking dark drives the real nativeTheme, the page sees dark, the file
		// stores it, then light and system again.
		await drive(browser, `${OPEN_SETTINGS} await d.click('#appearance [data-value="dark"]');`);
		const themeDark =
			nativeTheme.themeSource === 'dark' &&
			readFileSync(settingsFile, 'utf8') === '{"appearance":"dark"}' &&
			(await drive(browser, `return window.matchMedia('(prefers-color-scheme: dark)').matches;`)) === true;
		await drive(browser, `await d.click('#appearance [data-value="light"]');`);
		const themeLight = nativeTheme.themeSource === 'light';
		await drive(browser, `await d.click('#appearance [data-value="system"]');`);
		result.appearanceLive = themeDark && themeLight && nativeTheme.themeSource === 'system';

		// Open at login reflects the real (here in-memory) login item: off at start, set by the switch,
		// and a change made outside the app is picked up on the next focus without re-writing our file.
		const loginOffDefault = memoryLoginItem?.openAtLogin === false;
		await drive(browser, `await d.click('#loginSwitch');`);
		const loginSet = memoryLoginItem?.openAtLogin === true;
		if (memoryLoginItem) memoryLoginItem.openAtLogin = false;
		await drive(browser, `window.dispatchEvent(new Event('focus')); await d.settle();`);
		const loginRepainted = (await drive(browser, `return d.find('#loginSwitch').checked === false;`)) as boolean;
		result.openAtLoginOk = loginOffDefault && loginSet && loginRepainted;

		const title = browser.getTitle();
		const own = isOwnFile(browser.webContents.getURL(), INDEX_URL);
		const ok = own && title === PRODUCT_NAME && result.libraryRows > 0 && result.answered && result.folderRows > 0 && result.notice && result.moves > 0 && result.filed === 'filed' && result.persisted === true && result.raceSafe === true && result.titleWide === true && result.titleNarrow === true && result.appearanceLive === true && result.openAtLoginOk === true;
		if (ok) {
			console.error(`SMOKE OK: library ${result.libraryRows} rows, answer with citations, ${result.folderRows} folder rows, rename -> notice -> ${result.moves} moves -> applied -> reloaded with the saved list; stale dry-run after a save refused; app name centred on ask/filing/settings at 1200px and 360px; appearance live (dark/light/system); open-at-login reflects the real login item`);
			code = 0;
		} else {
			console.error(`SMOKE FAIL: own=${own} title=${title} checks=${JSON.stringify(result)}`);
		}
	} catch (error: unknown) {
		console.error(`SMOKE FAIL: ${String(error)}`);
	}
	clearTimeout(deadline);
	if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
	app.exit(code);
}

type Shot = { name: string; scenario: 'library' | 'no-owners'; width: number; height: number; steps: string; scrollTo?: string };

const OPEN_FILING = `await d.click('[data-section="filing"]');`;
const OPEN_OWNERS = `${OPEN_FILING} await d.click('[data-view="owners"]');`;
const OPEN_SETTINGS = `await d.click('[data-section="settings"]');`;
const ASK_STEPS = `await d.type('#askInput', 'When is the car loan paid off?'); await d.click('#askButton'); document.activeElement.blur();`;
const RENAME_AND_ADD = `${OPEN_FILING} await d.pick('Car'); await d.type('#nameInput', 'Vehicles'); await d.click('#saveButton');
  await d.click('[data-view="owners"]'); await d.click('#addButton'); await d.type('#nameInput', 'Example Studio'); await d.click('#saveButton');
  await d.click('[data-view="folders"]');`;

/** Ask, then RagFiling's ten states, each reached by using the app the way a person would. */
const SHOTS: Shot[] = [
	{ name: 'ask', scenario: 'library', width: 1200, height: 820, steps: ASK_STEPS },
	{ name: 'filing-folders', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_FILING} await d.pick('Finance');` },
	{ name: 'filing-editing', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_FILING} await d.pick('Car'); await d.type('#nameInput', 'Vehicles');` },
	{ name: 'filing-owners', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.pick('Alex Example');` },
	{ name: 'filing-owners-empty', scenario: 'no-owners', width: 1200, height: 820, steps: OPEN_OWNERS },
	{ name: 'filing-adding', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.click('#addButton'); await d.type('#nameInput', 'Example Studio');` },
	{ name: 'filing-error', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.click('#addButton'); await d.type('#nameInput', 'Example/Studio');` },
	{ name: 'filing-shared', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.pick('Shared');` },
	{ name: 'filing-changed', scenario: 'library', width: 1200, height: 820, steps: RENAME_AND_ADD },
	{ name: 'filing-preview', scenario: 'library', width: 1200, height: 820, steps: `${RENAME_AND_ADD} await d.click('#resortButton');` },
	{ name: 'filing-small', scenario: 'library', width: 360, height: 780, steps: `${OPEN_FILING} await d.pick('Finance');` },
	{ name: 'filing-small-form', scenario: 'library', width: 360, height: 780, steps: `${OPEN_FILING} await d.pick('Finance');`, scrollTo: '#detailPane' },
	{ name: 'ask-small', scenario: 'library', width: 360, height: 780, steps: ASK_STEPS },
	{ name: 'settings', scenario: 'library', width: 1200, height: 820, steps: OPEN_SETTINGS },
	{ name: 'settings-small', scenario: 'library', width: 360, height: 780, steps: OPEN_SETTINGS },
];

async function runShots(): Promise<void> {
	const deadline = setTimeout(() => {
		console.error('SHOTS FAIL: timed out after 300s');
		app.exit(1);
	}, 300000);
	const out = join(HERE, '..', 'screenshots');
	mkdirSync(out, { recursive: true });
	const browser = makeWindow();
	await loaded(browser);
	browser.show();
	try {
		for (const mode of ['light', 'dark'] as const) {
			nativeTheme.themeSource = mode;
			for (const shot of SHOTS) {
				const dir = freshFakeState();
				process.env.FAKE_SCENARIO = shot.scenario;
				browser.setSize(shot.width, shot.height);
				const reload = loaded(browser);
				browser.reload();
				await reload;
				await drive(browser, shot.steps);
				if (shot.scrollTo) await drive(browser, `d.find('${shot.scrollTo}').scrollIntoView(); await d.settle();`);
				const image = await browser.webContents.capturePage();
				writeFileSync(join(out, `${shot.name}-${mode}.png`), image.toPNG());
				rmSync(dir, { recursive: true, force: true });
			}
		}
	} catch (error: unknown) {
		console.error(`SHOTS FAIL: ${String(error)}`);
		clearTimeout(deadline);
		if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
		app.exit(1);
		return;
	}
	if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
	console.error(`SHOTS OK: ${SHOTS.length * 2} screenshots in screenshots/`);
	clearTimeout(deadline);
	app.exit(0);
}
