// Generates the PNG assets locally with Node's built-in zlib only. No remote design download happens
// here: the committed images are simple synthetic tiles/masks built from the RAG emblem idea (a
// document sheet with a magnifier). Run:
//   node scripts/make-assets.mjs
// This writes desktop/assets/{menubarTemplate.png,menubarTemplate@2x.png,icon.png}.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) {
		c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.allocUnsafe(4);
	len.writeUInt32BE(data.length);
	const name = Buffer.from(type, 'ascii');
	const crc = Buffer.allocUnsafe(4);
	crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([len, name, data, crc]);
}

function png(width, height, pixels) {
	const header = Buffer.allocUnsafe(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;
	const stride = width * 4;
	const raw = Buffer.allocUnsafe(height * (stride + 1));
	for (let y = 0; y < height; y += 1) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const idat = deflateSync(raw, { level: 9 });
	return Buffer.concat([
		Buffer.from([0x89, 0x45, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', idat),
		chunk('IEND', Buffer.allocUnsafe(0)),
	]);
}

function makeTemplate(size) {
	const pixels = Buffer.allocUnsafe(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const i = (y * size + x) * 4;
			pixels[i] = 0;
			pixels[i + 1] = 0;
			pixels[i + 2] = 0;
			pixels[i + 3] = 0;

			const page = x >= size * 0.24 && x <= size * 0.68 && y >= size * 0.18 && y <= size * 0.72;
			const line = page &&
				(
					y === Math.floor(size * 0.3) ||
					y === Math.floor(size * 0.42) ||
					y === Math.floor(size * 0.54)
				) &&
				x >= size * 0.3 &&
				x <= size * 0.62;

		 const dx = x - size * 0.72;
		 const dy = y - size * 0.68;
		 const r = Math.sqrt(dx * dx + dy * dy);
		 const ring = Math.abs(r - size * 0.16) <= 0.9;
		 const handle = x >= size * 0.84 && y >= size * 0.8 && x - size * 0.84 <= (y - size * 0.8) * 0.45;
		 if (page || line || ring || handle) pixels[i + 3] = 255;
		}
	}
	return png(size, size, pixels);
}

function makeIcon() {
	const size = 1024;
	const pixels = Buffer.allocUnsafe(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const i = (y * size + x) * 4;
			const inset = size * 0.07;
		 const corner = size * 0.17;
		 const tx = x - Math.max(inset, corner);
		 const ty = y - Math.max(inset, corner);
		 const sx = Math.min(Math.max(tx, 0), size - 2 * corner);
		 const sy = Math.min(Math.max(ty, 0), size - 2 * corner);
		 const dx = tx - sx;
		 const dy = ty - sy;
		 const inside = x >= inset && x <= size - inset && y >= inset && y <= size - inset;
		 const round = inside && (dx * dx + dy * dy <= corner * corner);
		 if (!round) {
			 pixels[i + 3] = 0;
			 continue;
		 }
		 const grain = (((x + y) % 64) < 2) ? 8 : 0;
		 pixels[i] = 12 + grain;
		 pixels[i + 1] = 30 + grain;
		 pixels[i + 2] = 44 + grain;
		 pixels[i + 3] = 255;

		 const sheet = x >= size * 0.28 && x <= size * 0.68 && y >= size * 0.24 && y <= size * 0.76;
		 const line = sheet &&
			 (
				 Math.abs(y - size * 0.36) <= size * 0.018 ||
				 Math.abs(y - size * 0.48) <= size * 0.018 ||
				 Math.abs(y - size * 0.6) <= size * 0.018
			 ) &&
			 x >= size * 0.34 &&
			 x <= size * 0.62;
		 const mx = x - size * 0.69;
		 const my = y - size * 0.67;
		 const r = Math.sqrt(mx * mx + my * my);
		 const ring = Math.abs(r - size * 0.17) <= size * 0.022;
		 const handle = x >= size * 0.81 && y >= size * 0.79 && x - size * 0.81 <= (y - size * 0.79) * 0.45;
		 if (sheet || line || ring || handle) {
			 pixels[i] = 248;
			 pixels[i + 1] = 249;
			 pixels[i + 2] = 250;
			 pixels[i + 3] = 255;
		 }
		}
	}
	return png(size, size, pixels);
}

writeFileSync(join(ASSETS, 'menubarTemplate.png'), makeTemplate(18));
writeFileSync(join(ASSETS, 'menubarTemplate@2x.png'), makeTemplate(36));
writeFileSync(join(ASSETS, 'icon.png'), makeIcon());
console.error('assets written');