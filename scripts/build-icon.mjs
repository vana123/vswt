import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '..', 'media', 'marketplace-icon.svg');
const pngPath = resolve(here, '..', 'media', 'icon.png');

const svg = readFileSync(svgPath);
await sharp(svg, { density: 384 })
  .resize(128, 128)
  .png({ compressionLevel: 9 })
  .toFile(pngPath);

console.log(`✓ Wrote ${pngPath}`);
