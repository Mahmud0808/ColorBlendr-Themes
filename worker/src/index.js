// ColorBlendr community themes worker.
// Endpoints:
//   POST /vote     { themeId, device }           -> { voted, upvotes }
//   POST /download { themeId, device }           -> { downloads }
//   GET  /votes?device=<hash>                    -> { themeIds: [...] }
//   GET  /counts                                 -> { upvotes: {id: n}, downloads: {id: n} }
//   POST /upload   { payload, turnstileToken }   -> { prUrl }
//   POST /report   { themeId, device }           -> { reported }
//   GET  /theme/<id>                             -> share landing page (HTML)
//
// Secrets: GITHUB_TOKEN, TURNSTILE_SECRET. Vars: GITHUB_REPO.

import {
    Hct,
    MaterialDynamicColors,
    SchemeContent,
    SchemeExpressive,
    SchemeFidelity,
    SchemeFruitSalad,
    SchemeMonochrome,
    SchemeNeutral,
    SchemeRainbow,
    SchemeTonalSpot,
    SchemeVibrant,
    argbFromHex,
    hexFromArgb
} from "@material/material-color-utilities";

// App MONET style -> MCU scheme; CMF is app-custom -> TonalSpot fallback.
const SCHEME_BY_STYLE = {
    MONOCHROMATIC: SchemeMonochrome,
    TONAL_SPOT: SchemeTonalSpot,
    VIBRANT: SchemeVibrant,
    RAINBOW: SchemeRainbow,
    EXPRESSIVE: SchemeExpressive,
    FIDELITY: SchemeFidelity,
    CONTENT: SchemeContent,
    FRUIT_SALAD: SchemeFruitSalad,
    SPRITZ: SchemeNeutral,
    CMF: SchemeTonalSpot
};

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
            if (request.method === "POST" && url.pathname === "/report") {
                return await report(request, env);
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

// One report per device per theme. First report on a theme opens a GitHub
// issue (the notify workflow mentions the owner); later ones just count.
async function report(request, env) {
    const body = await request.json().catch(() => null);
    const themeId = body?.themeId;
    const device = body?.device;
    if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
        return json({ error: "bad request" }, 400);
    }

    const existing = await env.DB
        .prepare("SELECT 1 FROM reports WHERE theme_id = ? AND device = ?")
        .bind(themeId, device).first();
    if (existing) return json({ reported: true });

    await env.DB
        .prepare("INSERT INTO reports (theme_id, device, created) VALUES (?, ?, ?)")
        .bind(themeId, device, Date.now()).run();

    const count = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM reports WHERE theme_id = ?")
        .bind(themeId).first();
    if ((count?.c ?? 0) === 1) {
        // Best-effort; the report is recorded either way.
        try {
            await openReportIssue(env, themeId);
        } catch {
        }
    }

    return json({ reported: true });
}

async function openReportIssue(env, themeId) {
    await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            accept: "application/vnd.github+json",
            "user-agent": "colorblendr-themes-worker"
        },
        body: JSON.stringify({
            title: `Report: ${themeId}`,
            body: [
                `A user reported the theme \`${themeId}\`.`,
                "",
                `File: https://github.com/${env.GITHUB_REPO}/blob/main/themes/${themeId}.json`,
                "",
                "Review the content; delete the file and close this issue if it violates the rules."
            ].join("\n")
        })
    });
}

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

    // Style -> MCU scheme + theme sliders on top = matches applied look.
    // Both modes derived; CSS swaps via prefers-color-scheme.
    const seed = HEX_COLOR.test(theme.seedColor ?? "") ? theme.seedColor : "#4285F4";
    const SchemeCtor = SCHEME_BY_STYLE[theme.style] ?? SchemeTonalSpot;
    const alpha = (hex, a) =>
        hex + Math.round(a * 255).toString(16).padStart(2, "0");
    const isMono = theme.style === "MONOCHROMATIC";

    const buildPalette = (isDark) => {
        const scheme = new SchemeCtor(Hct.fromInt(argbFromHex(seed)), isDark, 0);
        // Mode-specific themes carry light slider variants.
        const light = !isDark && theme.modeSpecificThemes;
        const accentSat = isMono ? 100
            : (light ? theme.accentSaturationLight : theme.accentSaturation) ?? 100;
        const bgSat = isMono ? 100
            : (light ? theme.backgroundSaturationLight : theme.backgroundSaturation) ?? 100;
        const bgLight = isMono ? 100
            : (light ? theme.backgroundLightnessLight : theme.backgroundLightness) ?? 100;

        const dc = MaterialDynamicColors;
        const role = (dynamicColor) => hexFromArgb(dynamicColor.getArgb(scheme));
        const accentRole = (dynamicColor) => adjustSaturation(role(dynamicColor), accentSat);
        const surfaceRole = (dynamicColor) => shiftLightness(
            adjustSaturation(role(dynamicColor), bgSat),
            bgLight
        );

        const glassBase = role(dc.inverseSurface);
        return {
            scheme,
            accentSat,
            colors: {
                bg: surfaceRole(dc.surface),
                glow: alpha(accentRole(dc.primary), 0.16),
                text: role(dc.onSurface),
                subtle: alpha(role(dc.onSurfaceVariant), 0.85),
                chipText: role(dc.onSurfaceVariant),
                accent: accentRole(dc.primary),
                onAccent: role(dc.onPrimary),
                onTonal: role(dc.onSurface),
                orb1: alpha(accentRole(dc.primary), 0.32),
                orb2: alpha(accentRole(dc.tertiary), 0.26),
                orb3: alpha(accentRole(dc.secondary), 0.18),
                glassFill: alpha(glassBase, 0.06),
                glassBorder: alpha(glassBase, 0.14),
                glassHighlight: alpha(glassBase, 0.10),
                chipFill: alpha(glassBase, 0.09),
                chipBorder: alpha(glassBase, 0.10),
                tonalFill: alpha(glassBase, 0.10),
                tonalBorder: alpha(glassBase, 0.12),
                dotRing: alpha(role(dc.surface), 0.55)
            }
        };
    };

    const dark = buildPalette(true);
    const lightMode = buildPalette(false);
    const scheme = dark.scheme;
    const accentSat = dark.accentSat;
    const cssVars = (c) =>
        Object.entries(c).map(([k, v]) => `--${k}: ${v};`).join(" ");

    const swatchColors = [theme.seedColor, theme.secondaryColor, theme.tertiaryColor]
        .filter((c) => c && HEX_COLOR.test(c));
    const swatches = swatchColors
        .map((c) => `<span class="dot" style="background:${c}"></span>`)
        .join("");

    // Favicon = ColorBlendr launcher mark (drop + swoosh) on a seed-tinted
    // gradient disc, mirroring the app icon's dynamic background.
    const favicon = "data:image/svg+xml," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(70)), accentSat)}"/>` +
        `<stop offset="1" stop-color="${adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(40)), accentSat)}"/>` +
        `</linearGradient></defs>` +
        `<circle cx="50" cy="50" r="50" fill="url(#g)"/>` +
        `<g transform="translate(50,50) scale(1.5) translate(-50,-50) translate(26.777779,26.777779) scale(0.46444446)">` +
        `<path fill="#fff" fill-opacity="0.4" d="M86.2,66.5Q86.8,61.7 86.1,57.2C104.3,66.1 106.8,81 82,81C59.7,81 29.9,74.8 10,61.2C-4.9,51.2 -4.9,38.8 21.2,39Q18.6,43.1 17.3,46.2Q0.1,46 12.8,54.6C34.8,68.6 62.1,73.6 84.5,74.4Q99.4,74.4 86.2,66.5z"/>` +
        `<path fill="#fff" fill-opacity="0.902" d="M82.6,70.2C56.5,68.5 34.3,62.5 18,52.5C20,43.5 33,24 49.8,6.6C72.5,31.5 88.3,50.5 82.6,70.2zM73.4,84.7C56,101 24,94 17.2,70.3C30.8,78.5 48.7,83.6 73.4,84.7z"/>` +
        `</g></svg>`
    );

    const thumbIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.12 2.06 7.58 7.6c-.37.37-.58.88-.58 1.41V19c0 1.1.9 2 2 2h9c.8 0 1.52-.48 1.84-1.21l3.26-7.61C23.94 10.2 22.49 8 20.34 8h-5.65l.95-4.58c.1-.5-.05-1.01-.41-1.37-.59-.58-1.53-.58-2.11.01ZM3 21c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2s-2 .9-2 2v8c0 1.1.9 2 2 2Z"/></svg>`;
    const downloadIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71ZM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1Z"/></svg>`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark.colors.bg}">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${lightMode.colors.bg}">
<link rel="icon" type="image/svg+xml" href="${favicon}">
<meta property="og:title" content="${esc(theme.name)} · ColorBlendr">
<meta property="og:description" content="${esc(theme.description)}">
<meta property="og:type" content="website">
<title>${esc(theme.name)} · ColorBlendr</title>
<style>
  :root { ${cssVars(dark.colors)} }
  @media (prefers-color-scheme: light) {
    :root { ${cssVars(lightMode.colors)} }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  /* Ambient color field behind the glass: three blurred hue orbs. */
  .bg { position: fixed; inset: 0; pointer-events: none; z-index: -1; }
  .orb { position: absolute; border-radius: 50%; filter: blur(90px); }
  .orb1 {
    width: 55vmax; height: 55vmax; top: -18vmax; left: -12vmax;
    background: var(--orb1);
  }
  .orb2 {
    width: 45vmax; height: 45vmax; bottom: -15vmax; right: -10vmax;
    background: var(--orb2);
  }
  .orb3 {
    width: 30vmax; height: 30vmax; top: 45%; left: 55%;
    background: var(--orb3);
  }
  .card {
    position: relative; overflow: hidden;
    width: min(400px, calc(100vw - 32px)); margin: 24px;
    padding: 40px 32px 32px; text-align: center;
    background: var(--glassFill);
    -webkit-backdrop-filter: blur(28px) saturate(1.5);
    backdrop-filter: blur(28px) saturate(1.5);
    border: 1px solid var(--glassBorder);
    border-radius: 28px;
    box-shadow: 0 24px 80px rgba(0,0,0,.45),
                inset 0 1px 0 var(--glassHighlight);
  }
  .glow {
    position: absolute; inset: 0 0 auto 0; height: 200px; pointer-events: none;
    background: radial-gradient(ellipse at 50% -20%, var(--glow), transparent 72%);
  }
  .brand {
    font-size: 11px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase;
    color: var(--subtle); margin-bottom: 28px;
  }
  .dots { position: relative; height: 64px; margin-bottom: 20px; }
  .dot {
    display: inline-block; width: 64px; height: 64px; border-radius: 50%;
    margin: 0 -10px; border: 4px solid var(--dotRing);
    box-shadow: 0 8px 24px rgba(0,0,0,.35);
  }
  h1 { margin: 0 0 4px; font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
  .author { color: var(--subtle); margin: 0 0 16px; font-size: 14px; }
  .desc { color: var(--chipText); font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
  .chips { display: flex; gap: 8px; justify-content: center; margin-bottom: 28px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 999px;
    background: var(--chipFill);
    border: 1px solid var(--chipBorder);
    color: var(--chipText);
    font-size: 13px; font-weight: 600;
  }
  .chip svg { display: block; }
  a.btn {
    display: block; padding: 15px 24px; border-radius: 999px; text-decoration: none;
    font-size: 15px; font-weight: 600; transition: filter .15s ease, transform .1s ease;
  }
  a.btn:hover { filter: brightness(1.06); }
  a.btn:active { transform: scale(.98); }
  .open { background: var(--accent); color: var(--onAccent); }
  .get {
    background: var(--tonalFill);
    border: 1px solid var(--tonalBorder);
    color: var(--onTonal); margin-top: 10px;
  }
</style>
</head>
<body>
<div class="bg">
  <div class="orb orb1"></div>
  <div class="orb orb2"></div>
  <div class="orb orb3"></div>
</div>
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

// Ports of the app's CAM16 slider math (ColorUtil.adjustSaturation /
// shiftLightness); Hct = same hue/chroma/lstar space as Cam.
function adjustSaturation(hex, saturation) {
    if (saturation === 100) return hex;
    const satF = (saturation - 100) / 100;
    const hct = Hct.fromInt(argbFromHex(hex));
    // 200 chroma target = max representable at this hue/tone.
    const target = Hct.from(hct.hue, 200, hct.tone);
    let chroma = hct.chroma;
    chroma += satF > 0 ? (target.chroma - chroma) * satF : chroma * satF;
    return hexFromArgb(Hct.from(hct.hue, chroma, hct.tone).toInt());
}

function shiftLightness(hex, lightness) {
    if (lightness === 100) return hex;
    const hct = Hct.fromInt(argbFromHex(hex));
    const tone = Math.max(0, Math.min(100, hct.tone + (lightness - 100) / 10));
    return hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
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
