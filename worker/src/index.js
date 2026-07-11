// ColorBlendr community themes worker.
// Endpoints:
//   POST /vote     { themeId, device }           -> { voted, upvotes }
//   POST /download { themeId, device }           -> { downloads }
//   GET  /votes?device=<hash>                    -> { themeIds: [...] }
//   GET  /counts                                 -> { upvotes: {id: n}, downloads: {id: n} }
//   POST /upload   { payload, turnstileToken }   -> { prUrl }
//
// Secrets: GITHUB_TOKEN, TURNSTILE_SECRET. Vars: GITHUB_REPO.

const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_REGEX = /^[a-f0-9]{64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MONET_STYLES = [
    "SPRITZ", "MONOCHROMATIC", "TONAL_SPOT", "VIBRANT", "RAINBOW",
    "EXPRESSIVE", "FIDELITY", "CONTENT", "FRUIT_SALAD", "CMF"
];
const SHADE_ROWS = ["system_accent1", "system_accent2", "system_accent3",
    "system_neutral1", "system_neutral2", "system_error"];
const SHADE_STEPS = ["0", "10", "50", "100", "200", "300", "400", "500",
    "600", "700", "800", "900", "1000"];
const VALID_SHADES = new Set(
    SHADE_ROWS.flatMap((row) => SHADE_STEPS.map((step) => `${row}_${step}`))
);
const MAX_UPLOADS_PER_DAY_PER_IP = 3;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            if (request.method === "POST" && url.pathname === "/vote") {
                return await vote(request, env);
            }
            if (request.method === "GET" && url.pathname === "/votes") {
                return await votesForDevice(url, env);
            }
            if (request.method === "POST" && url.pathname === "/download") {
                return await download(request, env);
            }
            if (request.method === "GET" && url.pathname === "/counts") {
                return await counts(env);
            }
            if (request.method === "POST" && url.pathname === "/upload") {
                return await upload(request, env);
            }
            return json({ error: "not found" }, 404);
        } catch (e) {
            return json({ error: "internal" }, 500);
        }
    }
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" }
    });
}

async function vote(request, env) {
    const body = await request.json().catch(() => null);
    const themeId = body?.themeId;
    const device = body?.device;
    if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
        return json({ error: "bad request" }, 400);
    }

    const existing = await env.DB
        .prepare("SELECT 1 FROM votes WHERE theme_id = ? AND device = ?")
        .bind(themeId, device).first();

    if (existing) {
        await env.DB.prepare("DELETE FROM votes WHERE theme_id = ? AND device = ?")
            .bind(themeId, device).run();
    } else {
        await env.DB.prepare(
            "INSERT INTO votes (theme_id, device, created) VALUES (?, ?, ?)")
            .bind(themeId, device, Date.now()).run();
    }

    const count = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM votes WHERE theme_id = ?")
        .bind(themeId).first();

    return json({ voted: !existing, upvotes: count?.c ?? 0 });
}

async function votesForDevice(url, env) {
    const device = url.searchParams.get("device") ?? "";
    if (!DEVICE_REGEX.test(device)) return json({ error: "bad request" }, 400);

    const rows = await env.DB
        .prepare("SELECT theme_id FROM votes WHERE device = ?")
        .bind(device).all();

    return json({ themeIds: (rows.results ?? []).map((r) => r.theme_id) });
}

// One download per device per theme; re-applying the same theme is free.
async function download(request, env) {
    const body = await request.json().catch(() => null);
    const themeId = body?.themeId;
    const device = body?.device;
    if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
        return json({ error: "bad request" }, 400);
    }

    await env.DB.prepare(
        "INSERT OR IGNORE INTO applies (theme_id, device, created) VALUES (?, ?, ?)")
        .bind(themeId, device, Date.now()).run();

    const count = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM applies WHERE theme_id = ?")
        .bind(themeId).first();

    return json({ downloads: count?.c ?? 0 });
}

async function counts(env) {
    const votes = await env.DB
        .prepare("SELECT theme_id, COUNT(*) AS c FROM votes GROUP BY theme_id")
        .all();
    const downloads = await env.DB
        .prepare("SELECT theme_id, COUNT(*) AS c FROM applies GROUP BY theme_id")
        .all();

    const out = { upvotes: {}, downloads: {} };
    for (const row of votes.results ?? []) out.upvotes[row.theme_id] = row.c;
    for (const row of downloads.results ?? []) out.downloads[row.theme_id] = row.c;
    return json(out);
}

// Strict server-side schema validation; mirrors the app's codec.
function validatePayload(p) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    if (p.schemaVersion !== 1) return null;

    const name = clean(p.name, 40);
    if (!name) return null;
    const description = cleanMultiline(p.description ?? "", 500);
    if (!description) return null;
    const author = clean(p.author ?? "", 40);

    if (!MONET_STYLES.includes(p.style)) return null;
    if (!HEX_COLOR.test(p.seedColor ?? "")) return null;
    for (const key of ["secondaryColor", "tertiaryColor"]) {
        if (p[key] != null && !HEX_COLOR.test(p[key])) return null;
    }
    for (const key of ["accentSaturation", "backgroundSaturation", "backgroundLightness",
        "accentSaturationLight", "backgroundSaturationLight", "backgroundLightnessLight"]) {
        const v = p[key] ?? 100;
        if (!Number.isInteger(v) || v < 0 || v > 200) return null;
    }
    for (const key of ["accurateShades", "pitchBlack", "tintText", "modeSpecificThemes"]) {
        if (p[key] != null && typeof p[key] !== "boolean") return null;
    }
    const spec = p.colorSpecVersion ?? 0;
    if (!Number.isInteger(spec) || spec < 0 || spec > 2) return null;
    const overrides = p.colorOverrides ?? {};
    if (typeof overrides !== "object" || Array.isArray(overrides)) return null;
    for (const [shade, color] of Object.entries(overrides)) {
        if (!VALID_SHADES.has(shade) || !HEX_COLOR.test(color)) return null;
    }

    const allowed = ["schemaVersion", "name", "description", "author", "style",
        "seedColor", "secondaryColor", "tertiaryColor", "accentSaturation",
        "backgroundSaturation", "backgroundLightness", "accurateShades",
        "pitchBlack", "tintText", "colorSpecVersion", "modeSpecificThemes",
        "accentSaturationLight", "backgroundSaturationLight",
        "backgroundLightnessLight", "colorOverrides"];
    for (const key of Object.keys(p)) {
        if (!allowed.includes(key)) return null;
    }

    return { ...p, name, description, author };
}

function clean(value, max) {
    if (typeof value !== "string") return null;
    return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function cleanMultiline(value, max) {
    if (typeof value !== "string") return null;
    return value.replace(/\r\n/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim().slice(0, max);
}

function slugify(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "").slice(0, 48) || "theme";
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function upload(request, env) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const body = await request.json().catch(() => null);

    const token = body?.turnstileToken;
    if (!token || !(await verifyTurnstile(token, ip, env))) {
        return json({ error: "verification failed" }, 403);
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM uploads WHERE ip = ? AND created > ?")
        .bind(ip, dayAgo).first();
    if ((recent?.c ?? 0) >= MAX_UPLOADS_PER_DAY_PER_IP) {
        return json({ error: "rate limited" }, 429);
    }

    const payload = validatePayload(body?.payload);
    if (!payload) return json({ error: "invalid theme" }, 400);

    const id = slugify(payload.name);
    const themeJson = JSON.stringify({ id, ...payload, createdAt: Math.floor(Date.now() / 1000) }, null, 2);
    const prUrl = await openPullRequest(env, id, payload.name, themeJson);
    if (!prUrl) return json({ error: "github error" }, 502);

    await env.DB.prepare("INSERT INTO uploads (ip, created) VALUES (?, ?)")
        .bind(ip, Date.now()).run();

    return json({ prUrl });
}

async function verifyTurnstile(token, ip, env) {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip })
    });
    const result = await response.json().catch(() => null);
    return result?.success === true;
}

async function openPullRequest(env, id, themeName, themeJson) {
    const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            accept: "application/vnd.github+json",
            "user-agent": "colorblendr-themes-worker",
            ...init.headers
        }
    });

    const main = await (await gh("/git/ref/heads/main")).json();
    const baseSha = main?.object?.sha;
    if (!baseSha) return null;

    const branch = `theme/${id}`;
    const created = await gh("/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha })
    });
    if (!created.ok) return null;

    const file = await gh(`/contents/themes/${id}.json`, {
        method: "PUT",
        body: JSON.stringify({
            message: `Add theme: ${themeName}`,
            content: btoa(unescape(encodeURIComponent(themeJson))),
            branch
        })
    });
    if (!file.ok) return null;

    const pr = await gh("/pulls", {
        method: "POST",
        body: JSON.stringify({
            title: `New theme: ${themeName}`,
            head: branch,
            base: "main",
            body: "Submitted anonymously from the ColorBlendr app. CI validates the schema; review the colors before merging."
        })
    });
    const prBody = await pr.json().catch(() => null);
    return prBody?.html_url ?? null;
}
