// One-off icon generator: renders src/app/icon.svg onto the v3 --page (light)
// background at PWA/iOS sizes. Run with: node scripts/gen-icons.mjs
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PAGE_BG = "#f9f9f7"; // v3 light --page
const svgPath = fileURLToPath(new URL("../src/app/icon.svg", import.meta.url));
const outDir = fileURLToPath(new URL("../public/icons/", import.meta.url));

const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];

const svg = await readFile(svgPath);
await mkdir(outDir, { recursive: true });

for (const [name, size] of targets) {
  const glyph = Math.round(size * 0.68); // mark centered with breathing room
  const mark = await sharp(svg, { density: 300 }).resize(glyph, glyph).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: PAGE_BG },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toFile(`${outDir}${name}`);
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
