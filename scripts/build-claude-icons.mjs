import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(here, '..', 'media');
const srcPath = resolve(mediaDir, '_claude-source.png');

const SIZE = 32;
const FRAMES = 12;
const FRAME_DELAY_MS = 80;

const baseRgba = await sharp(srcPath)
  .resize(SIZE, SIZE, { fit: 'cover' })
  .ensureAlpha()
  .raw()
  .toBuffer();

const idlePngPath = resolve(mediaDir, 'claude.png');
await sharp(baseRgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png({ compressionLevel: 9 })
  .toFile(idlePngPath);
console.log(`✓ Wrote ${idlePngPath}`);

async function pulseFrame(t) {
  const eased = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
  const scale = 1 - 0.16 * eased;
  const alpha = 1 - 0.4 * eased;
  const target = Math.max(1, Math.round(SIZE * scale));
  const offset = Math.floor((SIZE - target) / 2);

  const scaled = await sharp(baseRgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .resize(target, target)
    .raw()
    .toBuffer();
  for (let i = 3; i < scaled.length; i += 4) {
    scaled[i] = Math.round(scaled[i] * alpha);
  }
  const scaledPng = await sharp(scaled, { raw: { width: target, height: target, channels: 4 } })
    .png()
    .toBuffer();

  return sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaledPng, top: offset, left: offset }])
    .raw()
    .toBuffer();
}

const frames = [];
for (let i = 0; i < FRAMES; i++) {
  frames.push(await pulseFrame(i / FRAMES));
}
const combined = Buffer.concat(frames);

const gifPath = resolve(mediaDir, 'claude-running.gif');
await sharp(combined, {
  raw: { width: SIZE, height: SIZE * FRAMES, channels: 4, pageHeight: SIZE },
})
  .gif({ loop: 0, delay: Array(FRAMES).fill(FRAME_DELAY_MS) })
  .toFile(gifPath);
console.log(`✓ Wrote ${gifPath}`);
