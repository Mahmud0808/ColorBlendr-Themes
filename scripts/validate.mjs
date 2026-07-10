// Validates every themes/*.json against the schema. Fails CI on any error.
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MONET_STYLES = ["SPRITZ", "MONOCHROMATIC", "TONAL_SPOT", "VIBRANT",
    "RAINBOW", "EXPRESSIVE", "FIDELITY", "CONTENT", "FRUIT_SALAD", "CMF"];
const SHADE_ROWS = ["system_accent1", "system_accent2", "system_accent3",
    "system_neutral1", "system_neutral2", "system_error"];
const SHADE_STEPS = ["0", "10", "50", "100", "200", "300", "400", "500",
    "600", "700", "800", "900", "1000"];
const VALID_SHADES = new Set(
    SHADE_ROWS.flatMap((row) => SHADE_STEPS.map((step) => `${row}_${step}`))
);
const ALLOWED_KEYS = new Set(["schemaVersion", "id", "name", "description",
    "author", "style", "seedColor", "secondaryColor", "tertiaryColor",
    "accentSaturation", "backgroundSaturation", "backgroundLightness",
    "accurateShades", "pitchBlack", "tintText", "colorOverrides", "createdAt"]);

const errors = [];
const seenIds = new Set();

function check(file, condition, message) {
    if (!condition) errors.push(`${file}: ${message}`);
}

for (const file of readdirSync("themes").filter((f) => f.endsWith(".json"))) {
    const path = `themes/${file}`;
    let theme;
    try {
        const raw = readFileSync(path, "utf8");
        check(path, raw.length <= 8 * 1024, "payload exceeds 8KB");
        theme = JSON.parse(raw);
    } catch (e) {
        errors.push(`${path}: invalid JSON (${e.message})`);
        continue;
    }

    check(path, theme.schemaVersion === 1, "schemaVersion must be 1");
    check(path, ID_REGEX.test(theme.id ?? ""), "invalid id");
    check(path, theme.id === basename(file, ".json"), "id must match filename");
    check(path, !seenIds.has(theme.id), "duplicate id");
    seenIds.add(theme.id);

    check(path, typeof theme.name === "string" && theme.name.trim().length > 0
        && theme.name.length <= 40, "name must be 1-40 chars");
    check(path, (theme.description ?? "").length <= 200, "description too long");
    check(path, (theme.author ?? "").length <= 40, "author too long");
    check(path, MONET_STYLES.includes(theme.style), "unknown style");
    check(path, HEX_COLOR.test(theme.seedColor ?? ""), "invalid seedColor");

    for (const key of ["secondaryColor", "tertiaryColor"]) {
        check(path, theme[key] == null || HEX_COLOR.test(theme[key]), `invalid ${key}`);
    }
    for (const key of ["accentSaturation", "backgroundSaturation", "backgroundLightness"]) {
        const v = theme[key] ?? 100;
        check(path, Number.isInteger(v) && v >= 0 && v <= 200, `${key} out of range`);
    }
    for (const [shade, color] of Object.entries(theme.colorOverrides ?? {})) {
        check(path, VALID_SHADES.has(shade), `unknown override shade ${shade}`);
        check(path, HEX_COLOR.test(color), `invalid override color for ${shade}`);
    }
    for (const key of Object.keys(theme)) {
        check(path, ALLOWED_KEYS.has(key), `unknown key ${key}`);
    }
}

if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
}
console.log(`${seenIds.size} theme(s) valid`);
