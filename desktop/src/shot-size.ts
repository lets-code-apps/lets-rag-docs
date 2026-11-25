// Screenshot size policy: the Electron-free decisions the shot driver makes about the size of a
// capture, mirroring window-policy.ts (the decisions live in a plain, unit-tested module; `main.ts`
// only wires them). This module owns the one pair of fixed capture sizes, the bounded wait that
// confirms a size has settled, the single message format for a size mismatch, and a PNG-header reader.
// It imports nothing, so it runs under `node --test` with no Electron and no real sleeping.

// A size in pixels. The same shape is used for the size we ask for, the size the window reports, and
// the size the PNG header claims, so one comparison and one message cover all three.
export type Size = { width: number; height: number };

// The only two capture sizes, and they are content sizes (the visible page area, not the outer window
// frame). 660 sits under the height the macOS GitHub runner has been seen to give a taller window (674-677),
// with a margin, and above the tray window's minHeight (480), so the runner is never squeezed. `as const`
// gives literal types, so a Shot that says `size: 'square'` is a compile error, not a runtime surprise.
export const SHOT_SIZES = {
	wide: { width: 1200, height: 660 },
	narrow: { width: 360, height: 660 },
} as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Poll `read()` until it equals `want`, then return the last size read. A window whose content size
// has not settled (macOS can grow it a step or two late) resolves on the next poll; one that never
// settles gives up after `timeoutMs` and returns the wrong last read so the CALLER fails the shot rather
// than capturing at the wrong size. `read` and `sleep` are parameters (dependency injection) so the unit
// test can drive the polls with no real time; in Rust this would be
// `fn wait_for_size(read: FnMut() -> Size, sleep: FnMut(u64))`.
export async function waitForSize(
	read: () => Size,
	want: Size,
	opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Size> {
	const timeoutMs = opts.timeoutMs ?? 3000;
	const intervalMs = opts.intervalMs ?? 25;
	const sleep = opts.sleep ?? defaultSleep;
	let last = read();
	let waited = 0;
	while (!(last.width === want.width && last.height === want.height) && waited < timeoutMs) {
		await sleep(intervalMs);
		waited += intervalMs;
		last = read();
	}
	return last;
}

// The one message format for every size failure: "<what>: expected 1200x660, got 1200x674". Both the
// content-size check and the captured-PNG check use it, so a mismatch in the log always names the shot,
// the expected size and the actual size.
export function sizeMismatch(what: string, want: Size, got: Size): string {
	return `${what}: expected ${want.width}x${want.height}, got ${got.width}x${got.height}`;
}

// The pixel size the committed file will actually have. A PNG stores width and height in the IHDR chunk,
// which is the first chunk: 8-byte signature, then a 4-byte chunk length, then the 4-byte type "IHDR",
// then 4-byte big-endian width and 4-byte big-endian height. So the dimensions are at byte 16 and byte 20.
// Reading the header avoids any DIP-vs-pixel guesswork from `nativeImage` — this is the size that lands in
// git. It throws on anything that is not a PNG.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x44, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(png: Buffer): Size {
	if (png.length < 24) throw new Error('pngSize: not a PNG (too short to hold an IHDR)');
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (png[i] !== PNG_SIGNATURE[i]) throw new Error('pngSize: not a PNG (bad signature)');
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
