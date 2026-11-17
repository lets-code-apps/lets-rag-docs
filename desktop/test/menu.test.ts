import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTrayMenu, PRODUCT_NAME } from '../src/menu.ts';

test('tray menu has name, open, quit', () => {
	const menu = buildTrayMenu();
	assert.equal(menu[0].label, PRODUCT_NAME);
	assert.equal(menu[0].enabled, false);
	assert.equal(menu[1].label, `Open ${PRODUCT_NAME}`);
	assert.equal(menu[1].action, 'openWindow');
	assert.equal(menu[2].label, `Quit ${PRODUCT_NAME}`);
	assert.equal(menu[2].action, 'quit');
	assert.equal(menu[2].accelerator, 'Cmd+Q');
});