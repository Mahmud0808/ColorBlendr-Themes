// Schema versions shared by CI (scripts/validate.mjs) and the worker upload
// endpoint. v1 is what released apps understand; v2 adds token overrides and
// pitch black containers. v2 themes are hidden from old apps (they reject
// unknown schema versions), so a theme is v2 only when it uses a v2 field.

export const SCHEMA_V1 = 1;
export const SCHEMA_V2 = 2;
export const V2_KEYS = ["tokenOverrides", "pitchBlackContainers"];
// Marks themes made with the token engine; old apps ignore it, so it is
// allowed on v1 too. Absent = 1 (legacy token mapping for shade overrides).
export const ENGINE_KEY = "engineVersion";
export const MAX_BYTES = { [SCHEMA_V1]: 8 * 1024, [SCHEMA_V2]: 16 * 1024 };

const TOKEN_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SHADE_LINK =
    /^system_(accent[123]|neutral[12]|error)_(0|10|50|100|200|300|400|500|600|700|800|900|1000)(@[0-9A-Fa-f]{2})?$/;
const ARGB_COLOR = /^#[0-9A-Fa-f]{8}$/;
const MAX_TOKEN_OVERRIDES = 400;

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

export function schemaErrors(theme, byteLength) {
    const errors = [];
    const version = theme?.schemaVersion;
    if (version !== SCHEMA_V1 && version !== SCHEMA_V2) {
        return ["schemaVersion must be 1 or 2"];
    }
    if (byteLength > MAX_BYTES[version]) errors.push(`payload exceeds ${MAX_BYTES[version] / 1024}KB`);

    const usedV2 = V2_KEYS.filter((key) => theme[key] !== undefined);
    if (version === SCHEMA_V1 && usedV2.length > 0) errors.push(`${usedV2.join(", ")} requires schemaVersion 2`);
    if (version === SCHEMA_V2 && usedV2.length === 0) errors.push("schemaVersion 2 needs a v2 field");

    const engine = theme[ENGINE_KEY];
    if (engine !== undefined && !(Number.isInteger(engine) && engine >= 1 && engine <= 2)) {
        errors.push(`${ENGINE_KEY} must be 1 or 2`);
    }
    if (theme.pitchBlackContainers !== undefined && typeof theme.pitchBlackContainers !== "boolean") {
        errors.push("pitchBlackContainers must be a boolean");
    }
    if (theme.tokenOverrides !== undefined) errors.push(...tokenOverrideErrors(theme.tokenOverrides));
    return errors;
}

function tokenOverrideErrors(overrides) {
    if (!isObject(overrides)) return ["tokenOverrides must be an object"];
    const errors = [];
    let count = 0;
    for (const [mode, tokens] of Object.entries(overrides)) {
        if (mode !== "light" && mode !== "dark") {
            errors.push(`unknown tokenOverrides mode ${mode}`);
            continue;
        }
        if (!isObject(tokens)) {
            errors.push(`tokenOverrides.${mode} must be an object`);
            continue;
        }
        for (const [token, value] of Object.entries(tokens)) {
            count++;
            if (!TOKEN_NAME.test(token)) errors.push(`invalid token name ${token}`);
            if (typeof value !== "string" || !(SHADE_LINK.test(value) || ARGB_COLOR.test(value))) {
                errors.push(`invalid value for token ${token}`);
            }
        }
    }
    if (count > MAX_TOKEN_OVERRIDES) errors.push("too many token overrides");
    return errors;
}
