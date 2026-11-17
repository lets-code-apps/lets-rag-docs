// The tray menu as plain data. `main.ts` turns these descriptors into an Electron Menu. Keeping
// it pure (no `electron` import) means the menu can be tested without a GUI: the tray offers
// "open window" and "quit", never app start/stop (every engine call is one-shot).

export type MenuAction = 'openWindow' | 'quit' | null;

export type MenuDescriptor = {
	label: string;
	enabled: boolean;
	action: MenuAction;
	accelerator?: string;
};

export const PRODUCT_NAME = "Let's RAG Docs";

export function buildTrayMenu(): MenuDescriptor[] {
	return [
		{ label: PRODUCT_NAME, enabled: false, action: null },
		{ label: `Open ${PRODUCT_NAME}`, enabled: true, action: 'openWindow' },
		{ label: `Quit ${PRODUCT_NAME}`, enabled: true, action: 'quit', accelerator: 'Cmd+Q' },
	];
}