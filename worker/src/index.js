// ColorBlendr community themes worker.
// Endpoints:
//   POST /vote     { themeId, device }           -> { voted, upvotes }
//   POST /download { themeId, device }           -> { downloads }
//   GET  /votes?device=<hash>                    -> { themeIds: [...] }
//   GET  /counts                                 -> { upvotes: {id: n}, downloads: {id: n} }
//   POST /upload   { payload, turnstileToken }   -> { prUrl }
//   GET  /theme/<id>                             -> share landing page (HTML)
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
            if (request.method === "GET" && url.pathname.startsWith("/theme/")) {
                return await themePage(url, env);
            }
            return json({ error: "not found" }, 404);
        } catch (e) {
            return json({ error: "internal" }, 500);
        }
    }
};

// Share landing page: theme summary + "open in app" deep link. The custom
// scheme only resolves if the app is installed; page explains the fallback.
async function themePage(url, env) {
    const id = url.pathname.slice("/theme/".length);
    if (!ID_REGEX.test(id)) return new Response("Not found", { status: 404 });

    const indexResponse = await fetch(
        `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/index.json`,
        { cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (!indexResponse.ok) return new Response("Unavailable", { status: 502 });

    const index = await indexResponse.json().catch(() => null);
    const theme = index?.find?.((t) => t.id === id);
    if (!theme) return new Response("Theme not found", { status: 404 });

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

    // Page tinted from the theme's own seed: hue drives every surface.
    const hsl = hexToHsl(HEX_COLOR.test(theme.seedColor ?? "") ? theme.seedColor : "#6750A4");
    const tone = (s, l) => `hsl(${hsl.h} ${s}% ${l}%)`;
    const colors = {
        bg: tone(30, 7),
        glow: `hsla(${hsl.h} 80% 70% / 0.16)`,
        card: tone(22, 11),
        border: tone(20, 18),
        text: tone(15, 93),
        subtle: tone(8, 64),
        chipBg: tone(18, 16),
        chipText: tone(12, 80),
        accent: tone(75, 82),
        onAccent: tone(45, 14),
        tonal: tone(16, 20),
        onTonal: tone(15, 90)
    };

    const swatches = [theme.seedColor, theme.secondaryColor, theme.tertiaryColor]
        .filter((c) => c && HEX_COLOR.test(c))
        .map((c) => `<span class="dot" style="background:${c}"></span>`)
        .join("");

    const thumbIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.12 2.06 7.58 7.6c-.37.37-.58.88-.58 1.41V19c0 1.1.9 2 2 2h9c.8 0 1.52-.48 1.84-1.21l3.26-7.61C23.94 10.2 22.49 8 20.34 8h-5.65l.95-4.58c.1-.5-.05-1.01-.41-1.37-.59-.58-1.53-.58-2.11.01ZM3 21c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2s-2 .9-2 2v8c0 1.1.9 2 2 2Z"/></svg>`;
    const downloadIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71ZM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1Z"/></svg>`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${colors.bg}">
<meta property="og:title" content="${esc(theme.name)} · ColorBlendr">
<meta property="og:description" content="${esc(theme.description)}">
<meta property="og:type" content="website">
<title>${esc(theme.name)} · ColorBlendr</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: ${colors.bg}; color: ${colors.text};
    -webkit-font-smoothing: antialiased;
  }
  .card {
    position: relative; overflow: hidden;
    width: min(400px, calc(100vw - 32px)); margin: 24px;
    padding: 40px 32px 32px; text-align: center;
    background: ${colors.card}; border: 1px solid ${colors.border}; border-radius: 28px;
    box-shadow: 0 24px 80px rgba(0,0,0,.45);
  }
  .glow {
    position: absolute; inset: 0 0 auto 0; height: 200px; pointer-events: none;
    background: radial-gradient(ellipse at 50% -20%, ${colors.glow}, transparent 72%);
  }
  .brand {
    font-size: 11px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase;
    color: ${colors.subtle}; margin-bottom: 28px;
  }
  .dots { position: relative; height: 64px; margin-bottom: 20px; }
  .dot {
    display: inline-block; width: 64px; height: 64px; border-radius: 50%;
    margin: 0 -10px; border: 4px solid ${colors.card};
    box-shadow: 0 8px 24px rgba(0,0,0,.35);
  }
  h1 { margin: 0 0 4px; font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
  .author { color: ${colors.subtle}; margin: 0 0 16px; font-size: 14px; }
  .desc { color: ${colors.chipText}; font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
  .chips { display: flex; gap: 8px; justify-content: center; margin-bottom: 28px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 999px;
    background: ${colors.chipBg}; color: ${colors.chipText};
    font-size: 13px; font-weight: 600;
  }
  .chip svg { display: block; }
  a.btn {
    display: block; padding: 15px 24px; border-radius: 999px; text-decoration: none;
    font-size: 15px; font-weight: 600; transition: filter .15s ease, transform .1s ease;
  }
  a.btn:hover { filter: brightness(1.06); }
  a.btn:active { transform: scale(.98); }
  .open { background: ${colors.accent}; color: ${colors.onAccent}; }
  .get { background: ${colors.tonal}; color: ${colors.onTonal}; margin-top: 10px; }
</style>
</head>
<body>
<main class="card">
  <div class="glow"></div>
  <div class="brand">ColorBlendr Community</div>
  <div class="dots">${swatches}</div>
  <h1>${esc(theme.name)}</h1>
  <p class="author">by ${esc(theme.author || "Anonymous")}</p>
  <p class="desc">${esc(theme.description)}</p>
  <div class="chips">
    <span class="chip">${thumbIcon}${theme.upvotes ?? 0}</span>
    <span class="chip">${downloadIcon}${theme.downloads ?? 0}</span>
  </div>
  <a class="btn open" href="colorblendr://theme/${esc(id)}">Open in ColorBlendr</a>
  <a class="btn get" href="https://github.com/Mahmud0808/ColorBlendr">Get the app</a>
</main>
</body>
</html>`;

    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=3600"
        }
    });
}

// #rrggbb -> { h, s, l } (0-360 / 0-100 / 0-100).
function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
    }
    return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
}

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
