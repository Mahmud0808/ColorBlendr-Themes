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
	hexFromArgb,
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
	CMF: SchemeTonalSpot,
};

// App enum ordinal -> MCU spec. JS lib has no 2026 yet; nearest is 2025.
const SPEC_BY_VERSION = { 0: "2021", 1: "2025", 2: "2025" };
const DEFAULT_SPEC = "2025";

const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_REGEX = /^[a-f0-9]{64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MONET_STYLES = [
	"SPRITZ",
	"MONOCHROMATIC",
	"TONAL_SPOT",
	"VIBRANT",
	"RAINBOW",
	"EXPRESSIVE",
	"FIDELITY",
	"CONTENT",
	"FRUIT_SALAD",
	"CMF",
];
const SHADE_ROWS = [
	"system_accent1",
	"system_accent2",
	"system_accent3",
	"system_neutral1",
	"system_neutral2",
	"system_error",
];
const SHADE_STEPS = [
	"0",
	"10",
	"50",
	"100",
	"200",
	"300",
	"400",
	"500",
	"600",
	"700",
	"800",
	"900",
	"1000",
];
const VALID_SHADES = new Set(
	SHADE_ROWS.flatMap((row) => SHADE_STEPS.map((step) => `${row}_${step}`)),
);
const MAX_UPLOADS_PER_DAY = 3;

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
			if (url.pathname.startsWith("/admin/")) {
				return await admin(request, url, env);
			}
			if (request.method === "POST" && url.pathname === "/report") {
				return await report(request, env);
			}
			if (
				request.method === "GET" &&
				url.pathname.startsWith("/theme/")
			) {
				return await themePage(url, env);
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: "internal" }, 500);
		}
	},
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

	// Reports (and the issue they can open via the bot token) are only
	// accepted for themes that actually exist in the index.
	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const existing = await env.DB.prepare(
		"SELECT 1 FROM reports WHERE theme_id = ? AND device = ?",
	)
		.bind(themeId, device)
		.first();
	if (existing) return json({ reported: true });

	await env.DB.prepare(
		"INSERT INTO reports (theme_id, device, created) VALUES (?, ?, ?)",
	)
		.bind(themeId, device, Date.now())
		.run();

	const count = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM reports WHERE theme_id = ?",
	)
		.bind(themeId)
		.first();
	if ((count?.c ?? 0) === 1) {
		// Best-effort; the report is recorded either way.
		try {
			await openReportIssue(env, themeId);
		} catch {}
	}

	return json({ reported: true });
}

async function themeExists(id, env) {
	const response = await fetch(
		`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/index.json`,
		{ cf: { cacheTtl: 300, cacheEverything: true } },
	);
	if (!response.ok) return false;
	const index = await response.json().catch(() => null);
	return Array.isArray(index) && index.some((t) => t.id === id);
}

async function openReportIssue(env, themeId) {
	await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.GITHUB_TOKEN}`,
			accept: "application/vnd.github+json",
			"user-agent": "colorblendr-themes-worker",
		},
		body: JSON.stringify({
			title: `Report: ${themeId}`,
			body: [
				`A user reported the theme \`${themeId}\`.`,
				"",
				`File: https://github.com/${env.GITHUB_REPO}/blob/main/themes/${themeId}.json`,
				"",
				"Review the content; delete the file and close this issue if it violates the rules.",
			].join("\n"),
		}),
	});
}

// Share landing page: theme summary + "open in app" deep link. The custom
// scheme only resolves if the app is installed; page explains the fallback.
async function themePage(url, env) {
	const id = url.pathname.slice("/theme/".length);
	if (!ID_REGEX.test(id)) return new Response("Not found", { status: 404 });

	const indexResponse = await fetch(
		`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/index.json`,
		{ cf: { cacheTtl: 300, cacheEverything: true } },
	);
	if (!indexResponse.ok) return new Response("Unavailable", { status: 502 });

	const index = await indexResponse.json().catch(() => null);
	const theme = index?.find?.((t) => t.id === id);
	if (!theme) return new Response("Theme not found", { status: 404 });

	const esc = (s) =>
		String(s ?? "").replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c],
		);

	// Style -> MCU scheme + theme sliders on top = matches applied look.
	// Both modes derived; CSS swaps via prefers-color-scheme.
	const seed = HEX_COLOR.test(theme.seedColor ?? "")
		? theme.seedColor
		: "#4285F4";
	const SchemeCtor = SCHEME_BY_STYLE[theme.style] ?? SchemeTonalSpot;
	const alpha = (hex, a) =>
		hex +
		Math.round(a * 255)
			.toString(16)
			.padStart(2, "0");
	const isMono = theme.style === "MONOCHROMATIC";

	const swatchColors = [
		theme.seedColor,
		theme.secondaryColor,
		theme.tertiaryColor,
	].filter((c) => c && HEX_COLOR.test(c));

	const spec = SPEC_BY_VERSION[theme.colorSpecVersion] ?? DEFAULT_SPEC;

	const buildPalette = (isDark) => {
		const scheme = new SchemeCtor(
			Hct.fromInt(argbFromHex(seed)),
			isDark,
			0,
			spec,
		);
		// Mode-specific themes carry light slider variants.
		const light = !isDark && theme.modeSpecificThemes;
		const accentSat = isMono
			? 100
			: ((light ? theme.accentSaturationLight : theme.accentSaturation) ??
				100);
		const bgSat = isMono
			? 100
			: ((light
					? theme.backgroundSaturationLight
					: theme.backgroundSaturation) ?? 100);
		const bgLight = isMono
			? 100
			: ((light
					? theme.backgroundLightnessLight
					: theme.backgroundLightness) ?? 100);

		// Sliders on surfaces, per-role tone floor/ceiling: dark surface =
		// tone 6, raw shift lands on tone 0 = pure black page; floors keep
		// bg/card/chip elevation steps apart.
		const surfaceRole = (argb, minTone, maxTone) =>
			shiftLightness(
				adjustSaturation(hexFromArgb(argb), bgSat),
				bgLight,
				minTone,
				maxTone,
			);
		// Light ceilings sit well below the bg's tone 99: the default light
		// scheme puts surface ~98 and surfaceContainer ~94, which reads as
		// one flat sheet; 92/88 keep the elevation steps visible.
		const colors = {
			bg: surfaceRole(scheme.surface, 4, 99),
			text: hexFromArgb(scheme.onSurface),
			subtle: alpha(hexFromArgb(scheme.onSurfaceVariant), 0.85),
			chipText: hexFromArgb(scheme.onSurfaceVariant),
			accent: adjustSaturation(hexFromArgb(scheme.primary), accentSat),
			onAccent: hexFromArgb(scheme.onPrimary),
			card: surfaceRole(scheme.surfaceContainer, 10, isDark ? 96 : 92),
			chip: surfaceRole(
				scheme.surfaceContainerHigh,
				14,
				isDark ? 93 : 88,
			),
			tonal: hexFromArgb(scheme.secondaryContainer),
			onTonalBtn: hexFromArgb(scheme.onSecondaryContainer),
		};
		// Raw theme hex can share the card's tone and vanish; clamp per mode.
		swatchColors.forEach((c, i) => {
			colors["dot" + i] = contrastSafe(c, isDark);
		});
		return { scheme, accentSat, colors };
	};

	const dark = buildPalette(true);
	const lightMode = buildPalette(false);
	const scheme = dark.scheme;
	const accentSat = dark.accentSat;
	const cssVars = (c) =>
		Object.entries(c)
			.map(([k, v]) => `--${k}: ${v};`)
			.join(" ");

	const swatches = swatchColors
		.map(
			(_, i) =>
				`<span class="dot" style="background:var(--dot${i})"></span>`,
		)
		.join("");

	// Favicon = ColorBlendr launcher mark (drop + swoosh) on a seed-tinted
	// gradient disc, mirroring the app icon's dynamic background.
	const favicon =
		"data:image/svg+xml," +
		encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
				`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
				`<stop offset="0" stop-color="${adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(70)), accentSat)}"/>` +
				`<stop offset="1" stop-color="${adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(40)), accentSat)}"/>` +
				`</linearGradient></defs>` +
				`<circle cx="50" cy="50" r="50" fill="url(#g)"/>` +
				`<g transform="translate(50,50) scale(1.5) translate(-50,-50) translate(26.777779,26.777779) scale(0.46444446)">` +
				`<path fill="#fff" fill-opacity="0.4" d="M86.2,66.5Q86.8,61.7 86.1,57.2C104.3,66.1 106.8,81 82,81C59.7,81 29.9,74.8 10,61.2C-4.9,51.2 -4.9,38.8 21.2,39Q18.6,43.1 17.3,46.2Q0.1,46 12.8,54.6C34.8,68.6 62.1,73.6 84.5,74.4Q99.4,74.4 86.2,66.5z"/>` +
				`<path fill="#fff" fill-opacity="0.902" d="M82.6,70.2C56.5,68.5 34.3,62.5 18,52.5C20,43.5 33,24 49.8,6.6C72.5,31.5 88.3,50.5 82.6,70.2zM73.4,84.7C56,101 24,94 17.2,70.3C30.8,78.5 48.7,83.6 73.4,84.7z"/>` +
				`</g></svg>`,
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
<meta name="description" content="${esc(theme.description)}">
<link rel="canonical" href="${esc(url.origin)}/theme/${esc(id)}">
<meta property="og:title" content="${esc(theme.name)} - ColorBlendr">
<meta property="og:description" content="${esc(theme.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url.origin)}/theme/${esc(id)}">
<title>${esc(theme.name)} - ColorBlendr</title>
<style>
  :root {
    ${cssVars(dark.colors)}
    --aurOp: .3; --grainOp: .045; --glow: 16%;
    --font-d: "Outfit", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root { ${cssVars(lightMode.colors)} --aurOp: .5; --grainOp: .03; --glow: 28%; }
  }
  /* Same display face as the gallery site; GitHub Pages serves it with
     CORS enabled, so the cross-origin font load is allowed. */
  @font-face {
    font-family: "Outfit";
    src: url("https://mahmud0808.github.io/ColorBlendr-Themes/assets/fonts/outfit-var.woff2") format("woff2-variations");
    font-weight: 100 900;
    font-display: swap;
  }
  * { box-sizing: border-box; }
  body {
    /* dvh tracks mobile browser bars; vh fallback for old engines. */
    margin: 0; min-height: 100vh; min-height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  /* Aurora + film grain, mirroring the gallery site's backdrop. */
  .aurora {
    position: fixed; inset: -20%; z-index: 0; pointer-events: none;
    filter: blur(90px); opacity: var(--aurOp);
  }
  .aurora i { position: absolute; border-radius: 50%; will-change: transform; }
  .aurora i:nth-child(1) {
    width: 46vmax; height: 46vmax; left: -8%; top: -10%;
    background: radial-gradient(circle, var(--accent), transparent 70%);
    animation: aur-a 26s ease-in-out infinite alternate;
  }
  .aurora i:nth-child(2) {
    width: 38vmax; height: 38vmax; right: -6%; bottom: -12%;
    background: radial-gradient(circle, var(--dot0, var(--tonal)), transparent 70%);
    animation: aur-b 32s ease-in-out infinite alternate;
  }
  @keyframes aur-a { to { transform: translate(10vmax, 6vmax) scale(1.15); } }
  @keyframes aur-b { to { transform: translate(-9vmax, -5vmax) scale(.9); } }
  body::after {
    content: ""; position: fixed; inset: 0; z-index: 2; pointer-events: none;
    opacity: var(--grainOp);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 160px 160px;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(18px) scale(.98); }
    to { opacity: 1; transform: none; }
  }
  @keyframes fadeup {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(.4); }
    60% { transform: scale(1.08); }
    to { opacity: 1; transform: scale(1); }
  }
  .card {
    position: relative; z-index: 1;
    width: min(400px, calc(100vw - 32px)); margin: 24px;
    padding: 40px 32px 32px; text-align: center;
    background: var(--card); border-radius: 28px;
    border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
    box-shadow: 0 30px 80px -24px color-mix(in srgb, var(--accent) var(--glow), transparent);
    animation: rise .5s cubic-bezier(.2,.7,.2,1) backwards;
  }
  .card > * { animation: fadeup .45s cubic-bezier(.2,.7,.2,1) backwards; }
  .card > :nth-child(2) { animation-delay: .06s; }
  .card > :nth-child(3) { animation-delay: .1s; }
  .card > :nth-child(4) { animation-delay: .14s; }
  .card > :nth-child(5) { animation-delay: .18s; }
  .card > :nth-child(6) { animation-delay: .22s; }
  .card > :nth-child(7) { animation-delay: .26s; }
  .card > :nth-child(8) { animation-delay: .3s; }
  .brand {
    font-family: var(--font-d);
    font-size: 11px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase;
    color: var(--subtle); margin-bottom: 28px;
  }
  .dots { position: relative; height: 64px; margin-bottom: 20px; }
  .dot {
    display: inline-block; width: 64px; height: 64px; border-radius: 50%;
    margin: 0 -10px; border: 4px solid var(--card);
    animation: pop .55s cubic-bezier(.34,1.56,.64,1) backwards;
    transition: transform .25s cubic-bezier(.2,.7,.2,1);
  }
  .dot:nth-child(1) { animation-delay: .12s; }
  .dot:nth-child(2) { animation-delay: .2s; }
  .dot:nth-child(3) { animation-delay: .28s; }
  .dot:hover { transform: translateY(-5px); }
  h1 { margin: 0 0 4px; font-family: var(--font-d); font-size: 26px; font-weight: 600; letter-spacing: -.01em; }
  .author { color: var(--subtle); margin: 0 0 16px; font-size: 14px; }
  .desc { color: var(--chipText); font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
  .chips { display: flex; gap: 8px; justify-content: center; margin-bottom: 28px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 999px;
    background: var(--chip); color: var(--chipText);
    font-size: 13px; font-weight: 600;
    transition: transform .2s cubic-bezier(.2,.7,.2,1);
  }
  .chip:hover { transform: translateY(-2px); }
  .chip svg { display: block; }
  a.btn {
    display: block; padding: 15px 24px; border-radius: 999px; text-decoration: none;
    font-family: var(--font-d); font-size: 15px; font-weight: 600;
    transition: filter .15s ease, transform .15s cubic-bezier(.2,.7,.2,1),
                border-radius .25s cubic-bezier(.2,.7,.2,1), box-shadow .2s ease;
  }
  a.btn:hover { filter: brightness(1.06); transform: translateY(-2px); }
  a.btn:active { transform: scale(.97); border-radius: 18px; }
  .open { background: var(--accent); color: var(--onAccent); }
  .open:hover { box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 35%, transparent); }
  .get { background: var(--tonal); color: var(--onTonalBtn); margin-top: 10px; }
  @media (prefers-reduced-motion: reduce) {
    .card, .card > *, .dot, .aurora i { animation: none; }
    .dot, .chip, a.btn { transition: none; }
  }
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i></i><i></i></div>
<main class="card">
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
			"cache-control": "public, max-age=3600",
		},
	});
}

// Swatch dot tone clamped away from the card surface (dark card ~tone 12,
// light ~94) so near-black/near-white seeds stay visible. Hue/chroma kept.
function contrastSafe(hex, isDark) {
	const hct = Hct.fromInt(argbFromHex(hex));
	const tone = isDark ? Math.max(hct.tone, 30) : Math.min(hct.tone, 80);
	if (tone === hct.tone) return hex;
	return hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
}

// Port of the app's CAM16 lightness slider (ColorUtil.shiftLightness) with
// optional tone bounds so page surfaces never collapse to black/white.
function shiftLightness(hex, lightness, minTone = 0, maxTone = 100) {
	const hct = Hct.fromInt(argbFromHex(hex));
	const tone = Math.max(
		minTone,
		Math.min(maxTone, hct.tone + (lightness - 100) / 10),
	);
	if (tone === hct.tone) return hex;
	return hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
}

// Port of the app's CAM16 saturation slider (ColorUtil.adjustSaturation);
// Hct = same hue/chroma/lstar space as Cam.
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

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function vote(request, env) {
	const body = await request.json().catch(() => null);
	const themeId = body?.themeId;
	const device = body?.device;
	if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
		return json({ error: "bad request" }, 400);
	}

	const existing = await env.DB.prepare(
		"SELECT 1 FROM votes WHERE theme_id = ? AND device = ?",
	)
		.bind(themeId, device)
		.first();

	if (existing) {
		await env.DB.prepare(
			"DELETE FROM votes WHERE theme_id = ? AND device = ?",
		)
			.bind(themeId, device)
			.run();
	} else {
		await env.DB.prepare(
			"INSERT INTO votes (theme_id, device, created) VALUES (?, ?, ?)",
		)
			.bind(themeId, device, Date.now())
			.run();
	}

	const count = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM votes WHERE theme_id = ?",
	)
		.bind(themeId)
		.first();

	return json({ voted: !existing, upvotes: count?.c ?? 0 });
}

async function votesForDevice(url, env) {
	const device = url.searchParams.get("device") ?? "";
	if (!DEVICE_REGEX.test(device)) return json({ error: "bad request" }, 400);

	const rows = await env.DB.prepare(
		"SELECT theme_id FROM votes WHERE device = ?",
	)
		.bind(device)
		.all();

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
		"INSERT OR IGNORE INTO applies (theme_id, device, created) VALUES (?, ?, ?)",
	)
		.bind(themeId, device, Date.now())
		.run();

	const count = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM applies WHERE theme_id = ?",
	)
		.bind(themeId)
		.first();

	return json({ downloads: count?.c ?? 0 });
}

async function counts(env) {
	const votes = await env.DB.prepare(
		"SELECT theme_id, COUNT(*) AS c FROM votes GROUP BY theme_id",
	).all();
	const downloads = await env.DB.prepare(
		"SELECT theme_id, COUNT(*) AS c FROM applies GROUP BY theme_id",
	).all();

	const out = { upvotes: {}, downloads: {} };
	for (const row of votes.results ?? []) out.upvotes[row.theme_id] = row.c;
	for (const row of downloads.results ?? [])
		out.downloads[row.theme_id] = row.c;
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
	for (const key of [
		"accentSaturation",
		"backgroundSaturation",
		"backgroundLightness",
		"accentSaturationLight",
		"backgroundSaturationLight",
		"backgroundLightnessLight",
	]) {
		const v = p[key] ?? 100;
		if (!Number.isInteger(v) || v < 0 || v > 200) return null;
	}
	for (const key of [
		"accurateShades",
		"pitchBlack",
		"tintText",
		"modeSpecificThemes",
	]) {
		if (p[key] != null && typeof p[key] !== "boolean") return null;
	}
	const spec = p.colorSpecVersion ?? 0;
	if (!Number.isInteger(spec) || spec < 0 || spec > 2) return null;
	const overrides = p.colorOverrides ?? {};
	if (typeof overrides !== "object" || Array.isArray(overrides)) return null;
	for (const [shade, color] of Object.entries(overrides)) {
		if (!VALID_SHADES.has(shade) || !HEX_COLOR.test(color)) return null;
	}

	const allowed = [
		"schemaVersion",
		"name",
		"description",
		"author",
		"style",
		"seedColor",
		"secondaryColor",
		"tertiaryColor",
		"accentSaturation",
		"backgroundSaturation",
		"backgroundLightness",
		"accurateShades",
		"pitchBlack",
		"tintText",
		"colorSpecVersion",
		"modeSpecificThemes",
		"accentSaturationLight",
		"backgroundSaturationLight",
		"backgroundLightnessLight",
		"colorOverrides",
	];
	for (const key of Object.keys(p)) {
		if (!allowed.includes(key)) return null;
	}

	return { ...p, name, description, author };
}

function clean(value, max) {
	if (typeof value !== "string") return null;
	return value
		.replace(/[\u0000-\u001F\u007F]/g, "")
		.trim()
		.slice(0, max);
}

function cleanMultiline(value, max) {
	if (typeof value !== "string") return null;
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, max);
}

function slugify(name) {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "theme";
	return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function upload(request, env) {
	const body = await request.json().catch(() => null);

	// Same salted SSAID hash as votes; raw identity never stored.
	const device = body?.device;
	if (!DEVICE_REGEX.test(device ?? ""))
		return json({ error: "bad request" }, 400);

	const blocked = await env.DB.prepare(
		"SELECT 1 FROM blocked_devices WHERE device = ?",
	)
		.bind(device)
		.first();
	if (blocked) return json({ error: "forbidden" }, 403);

	const token = body?.turnstileToken;
	if (!token || !(await verifyTurnstile(token, env))) {
		return json({ error: "verification failed" }, 403);
	}

	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	const recent = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM uploads WHERE device = ? AND created > ?",
	)
		.bind(device, dayAgo)
		.first();
	if ((recent?.c ?? 0) >= MAX_UPLOADS_PER_DAY) {
		return json({ error: "rate limited" }, 429);
	}

	const payload = validatePayload(body?.payload);
	if (!payload) return json({ error: "invalid theme" }, 400);

	// Queue only — nothing reaches GitHub until /admin/approve.
	const id = slugify(payload.name);
	await env.DB.prepare(
		"INSERT INTO pending (id, name, author, payload, device, created) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			payload.name,
			payload.author ?? "",
			JSON.stringify(payload),
			device,
			Date.now(),
		)
		.run();

	await env.DB.prepare("INSERT INTO uploads (device, created) VALUES (?, ?)")
		.bind(device, Date.now())
		.run();

	return json({ queued: true });
}

const MAX_ADMIN_FAILURES_PER_HOUR = 5;

async function hashIp(ip) {
	const data = new TextEncoder().encode(`${ip}colorblendr-ip-v1`);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Constant-time key comparison; equal length required by timingSafeEqual.
function adminKeyMatches(candidate, secret) {
	if (!candidate || !secret) return false;
	const enc = new TextEncoder();
	const a = enc.encode(candidate);
	const b = enc.encode(secret);
	if (a.byteLength !== b.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a, b);
}

// Owner-only queue review. Auth = x-admin-key header vs ADMIN_KEY secret
// (generate with `openssl rand -hex 32`; never ships in the app or either
// repo). Brute force is dead on arrival: 256-bit key space + 5 failed
// attempts/hour/IP lockout + constant-time compare.
async function admin(request, url, env) {
	const ipHash = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);
	const hourAgo = Date.now() - 60 * 60 * 1000;
	const failures = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM admin_attempts WHERE ip = ? AND created > ?",
	)
		.bind(ipHash, hourAgo)
		.first();
	if ((failures?.c ?? 0) >= MAX_ADMIN_FAILURES_PER_HOUR) {
		return json({ error: "too many attempts" }, 429);
	}

	const key = request.headers.get("x-admin-key");
	if (!adminKeyMatches(key, env.ADMIN_KEY)) {
		await env.DB.prepare(
			"INSERT INTO admin_attempts (ip, created) VALUES (?, ?)",
		)
			.bind(ipHash, Date.now())
			.run();
		await env.DB.prepare("DELETE FROM admin_attempts WHERE created < ?")
			.bind(Date.now() - 24 * 60 * 60 * 1000)
			.run();
		return json({ error: "unauthorized" }, 401);
	}

	if (request.method === "GET" && url.pathname === "/admin/pending") {
		const rows = await env.DB.prepare(
			"SELECT id, name, author, payload, device, created FROM pending ORDER BY created",
		).all();
		return json({
			pending: (rows.results ?? []).map((r) => ({
				id: r.id,
				name: r.name,
				author: r.author,
				device: r.device,
				created: r.created,
				payload: JSON.parse(r.payload),
			})),
		});
	}

	if (request.method === "GET" && url.pathname === "/admin/blocked") {
		const rows = await env.DB.prepare(
			"SELECT device, reason, created FROM blocked_devices ORDER BY created DESC",
		).all();
		return json({ blocked: rows.results ?? [] });
	}

	// Block also drops every queued submission from that device. reason
	// keeps the offender identifiable after the queue rows are gone.
	if (request.method === "POST" && url.pathname === "/admin/block") {
		const body = await request.json().catch(() => null);
		const target = body?.device;
		if (!DEVICE_REGEX.test(target ?? ""))
			return json({ error: "bad request" }, 400);
		const reason = clean(body?.reason ?? "", 200) ?? "";

		await env.DB.prepare(
			"INSERT OR IGNORE INTO blocked_devices (device, reason, created) VALUES (?, ?, ?)",
		)
			.bind(target, reason, Date.now())
			.run();
		await env.DB.prepare("DELETE FROM pending WHERE device = ?")
			.bind(target)
			.run();
		return json({ blocked: true });
	}

	if (request.method === "POST" && url.pathname === "/admin/unblock") {
		const body = await request.json().catch(() => null);
		const target = body?.device;
		if (!DEVICE_REGEX.test(target ?? ""))
			return json({ error: "bad request" }, 400);

		await env.DB.prepare("DELETE FROM blocked_devices WHERE device = ?")
			.bind(target)
			.run();
		return json({ unblocked: true });
	}

	if (request.method === "POST" && url.pathname === "/admin/approve") {
		const body = await request.json().catch(() => null);
		const id = body?.id;
		if (!ID_REGEX.test(id ?? ""))
			return json({ error: "bad request" }, 400);

		const row = await env.DB.prepare(
			"SELECT name, payload FROM pending WHERE id = ?",
		)
			.bind(id)
			.first();
		if (!row) return json({ error: "not found" }, 404);

		const payload = JSON.parse(row.payload);
		const themeJson = JSON.stringify(
			{ id, ...payload, createdAt: Math.floor(Date.now() / 1000) },
			null,
			2,
		);
		const prUrl = await openPullRequest(env, id, row.name, themeJson);
		if (!prUrl) return json({ error: "github error" }, 502);

		await env.DB.prepare("DELETE FROM pending WHERE id = ?").bind(id).run();
		return json({ prUrl });
	}

	if (request.method === "POST" && url.pathname === "/admin/reject") {
		const body = await request.json().catch(() => null);
		const id = body?.id;
		if (!ID_REGEX.test(id ?? ""))
			return json({ error: "bad request" }, 400);

		await env.DB.prepare("DELETE FROM pending WHERE id = ?").bind(id).run();
		return json({ rejected: true });
	}

	return json({ error: "not found" }, 404);
}

async function verifyTurnstile(token, env) {
	const response = await fetch(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				secret: env.TURNSTILE_SECRET,
				response: token,
			}),
		},
	);
	const result = await response.json().catch(() => null);
	return result?.success === true;
}

async function openPullRequest(env, id, themeName, themeJson) {
	const gh = (path, init = {}) =>
		fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${env.GITHUB_TOKEN}`,
				accept: "application/vnd.github+json",
				"user-agent": "colorblendr-themes-worker",
				...init.headers,
			},
		});

	const main = await (await gh("/git/ref/heads/main")).json();
	const baseSha = main?.object?.sha;
	if (!baseSha) return null;

	const branch = `theme/${id}`;
	const created = await gh("/git/refs", {
		method: "POST",
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
	});
	if (!created.ok) return null;

	const file = await gh(`/contents/themes/${id}.json`, {
		method: "PUT",
		body: JSON.stringify({
			message: `Add theme: ${themeName}`,
			content: btoa(unescape(encodeURIComponent(themeJson))),
			branch,
		}),
	});
	if (!file.ok) return null;

	const pr = await gh("/pulls", {
		method: "POST",
		body: JSON.stringify({
			title: `New theme: ${themeName}`,
			head: branch,
			base: "main",
			body: "Submitted anonymously from the ColorBlendr app. CI validates the schema; review the colors before merging.",
		}),
	});
	const prBody = await pr.json().catch(() => null);
	return prBody?.html_url ?? null;
}
