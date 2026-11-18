import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  isAllowedSetting,
  parseSettings,
  loadSettings,
  saveSettings,
  SettingsController,
  type Appearance,
  type SettingsHost,
} from '../src/settings.ts';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-')), name);
}

test('parseSettings reads a valid file and falls back on anything else', () => {
  assert.deepEqual(parseSettings('{"appearance":"dark"}'), { appearance: 'dark' });
  for (const bad of ['', 'not json', 'null', '[]', '{"appearance":"purple"}', '{"appearance":1}', '{}']) {
    assert.deepEqual(parseSettings(bad), DEFAULT_SETTINGS, bad);
  }
});

test('isAllowedSetting accepts only known names with the right value type', () => {
  assert.ok(isAllowedSetting('appearance', 'light'));
  assert.ok(isAllowedSetting('openAtLogin', false));
  assert.equal(isAllowedSetting('appearance', 'purple'), false);
  assert.equal(isAllowedSetting('openAtLogin', 'yes'), false);
  assert.equal(isAllowedSetting('theme', 'dark'), false);
  assert.equal(isAllowedSetting('__proto__', true), false);
});

test('loadSettings defaults when the file is missing, and when it holds garbage', () => {
  const missing = tempFile('missing.json');
  assert.deepEqual(loadSettings(missing), DEFAULT_SETTINGS);

  const garbage = tempFile('garbage.json');
  writeFileSync(garbage, '{"appearance":"purple"} not even json');
  assert.deepEqual(loadSettings(garbage), DEFAULT_SETTINGS);
});

test('saveSettings round-trips, creates a missing parent dir, and never throws on a bad path', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-')), 'nested', 'deeper', 'settings.json');
  assert.equal(saveSettings(file, { appearance: 'dark' }), true);
  assert.deepEqual(loadSettings(file), { appearance: 'dark' });

  // The parent is a regular file, so the write cannot happen: false, not a throw.
  const dir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-'));
  const blockedFile = join(dir, 'blocker');
  writeFileSync(blockedFile, 'a file where a folder should be');
  const blocked = join(blockedFile, 'settings.json');
  assert.equal(saveSettings(blocked, { appearance: 'dark' }), false);
});

function makeHost(start = false): { host: SettingsHost; theme: () => Appearance | undefined; login: () => boolean } {
  let theme: Appearance | undefined;
  let login = start;
  const host: SettingsHost = {
    setTheme: (appearance) => {
      theme = appearance;
    },
    getOpenAtLogin: () => login,
    setOpenAtLogin: (value) => {
      login = value;
    },
  };
  return { host, theme: () => theme, login: () => login };
}

test('SettingsController payload re-reads the host login state every call', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.payload(), { appearance: 'system', openAtLogin: false });
  controller.set('openAtLogin', true);
  assert.deepEqual(controller.payload(), { appearance: 'system', openAtLogin: true });
});

test('set appearance writes the file, moves the theme, and returns the new truth', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.set('appearance', 'dark'), { appearance: 'dark', openAtLogin: false });
  assert.equal(h.theme(), 'dark');
  assert.deepEqual(loadSettings(file), { appearance: 'dark' });
});

test('set openAtLogin touches the OS login item but never our file', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.set('openAtLogin', true), { appearance: 'system', openAtLogin: true });
  assert.equal(h.login(), true);
  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS); // still no stored appearance
});

test('set refuses anything unknown and leaves the host untouched', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  for (const bad of [
    ['appearance', 'purple'],
    ['openAtLogin', 'yes'],
    ['theme', 'dark'],
    ['__proto__', true],
  ] as const) {
    assert.equal(controller.set(bad[0], bad[1]), null, `${bad[0]}=${String(bad[1])}`);
  }
  assert.equal(h.theme(), undefined);
  assert.equal(h.login(), false);
});

test('a failed write still applies the theme (choice holds for this run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-'));
  const blockedFile = join(dir, 'blocker');
  writeFileSync(blockedFile, 'a file where a folder should be');
  const blocked = join(blockedFile, 'settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(blocked, h.host);
  assert.deepEqual(controller.set('appearance', 'dark'), { appearance: 'dark', openAtLogin: false });
  assert.equal(h.theme(), 'dark');
  assert.deepEqual(loadSettings(blocked), DEFAULT_SETTINGS); // not persisted
});

test('a new controller over the same file re-applies the saved appearance (survives a restart)', () => {
  const file = tempFile('settings.json');
  const first = makeHost(false);
  new SettingsController(file, first.host).set('appearance', 'dark');

  const second = makeHost(false);
  const reloaded = new SettingsController(file, second.host);
  reloaded.load();
  assert.equal(second.theme(), 'dark');
  assert.deepEqual(reloaded.payload(), { appearance: 'dark', openAtLogin: false });
});
