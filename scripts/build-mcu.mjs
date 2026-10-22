// Bundles material-color-utilities from an upstream checkout into
// assets/vendor/mcu.js so the site and worker run the same MCU revision as
// the app (pinned by the app's materialcolorutilities/upstream submodule).
//   node scripts/build-mcu.mjs <path-to-material-color-utilities>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = "assets/vendor/mcu.js";
const checkout = process.argv[2];
if (!checkout) {
    console.error("usage: node scripts/build-mcu.mjs <path-to-material-color-utilities>");
    process.exit(1);
}

const ts = resolve(checkout, "typescript").replaceAll("\\", "/");
const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const entry = `
export { Hct } from "${ts}/hct/hct.ts";
export { TonalPalette } from "${ts}/palettes/tonal_palette.ts";
export { DynamicScheme } from "${ts}/dynamiccolor/dynamic_scheme.ts";
export { MaterialDynamicColors } from "${ts}/dynamiccolor/material_dynamic_colors.ts";
export { SchemeCmf } from "${ts}/scheme/scheme_cmf.ts";
export { SchemeContent } from "${ts}/scheme/scheme_content.ts";
export { SchemeExpressive } from "${ts}/scheme/scheme_expressive.ts";
export { SchemeFidelity } from "${ts}/scheme/scheme_fidelity.ts";
export { SchemeFruitSalad } from "${ts}/scheme/scheme_fruit_salad.ts";
export { SchemeMonochrome } from "${ts}/scheme/scheme_monochrome.ts";
export { SchemeNeutral } from "${ts}/scheme/scheme_neutral.ts";
export { SchemeRainbow } from "${ts}/scheme/scheme_rainbow.ts";
export { SchemeTonalSpot } from "${ts}/scheme/scheme_tonal_spot.ts";
export { SchemeVibrant } from "${ts}/scheme/scheme_vibrant.ts";
export { alphaFromArgb, argbFromLab, labFromArgb } from "${ts}/utils/color_utils.ts";
export { argbFromHex, hexFromArgb } from "${ts}/utils/string_utils.ts";
`;

const dir = mkdtempSync(join(tmpdir(), "mcu-"));
try {
    const entryFile = join(dir, "entry.ts");
    writeFileSync(entryFile, entry);
    execFileSync("npx", [
        "--yes", "esbuild@0.28.2", entryFile,
        "--bundle", "--format=esm", "--minify", "--target=es2022",
        `--outfile=${OUT}`,
    ], { stdio: "inherit", shell: process.platform === "win32" });
    const banner = `// material-color-utilities ${commit} (Apache-2.0), bundled by scripts/build-mcu.mjs
`;
    writeFileSync(OUT, banner + readFileSync(OUT, "utf8"));
    console.log(`assets/vendor/mcu.js built from ${commit}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
