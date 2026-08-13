// ColorBlendr community themes worker.
// Endpoints:
//   POST /vote     { themeId, device }           -> { voted, upvotes }  (dedup device|ip)
//   POST /download { themeId, device }           -> { downloads }       (dedup device|ip)
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
const MAX_NAME = 40;
const MAX_DESCRIPTION = 500;
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
const MAX_REPORTS_PER_DAY = 3;

// colorOverrides keys are Android palette resources, system_<row>_<step>.
// Steps are fixed tonal stops; MCU roles land between them (dark surface is
// tone 4, surfaceContainer 9), so overrides act as hue/chroma anchors and the
// role keeps its own tone. Mirrors assets/site.js so both previews agree.
const relLum = (hex) => {
	const c = [1, 3, 5].map((i) => {
		const v = parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const contrast = (a, b) => {
	const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};

function ensureContrast(fg, bg, min = 4.5) {
	if (contrast(fg, bg) >= min) return fg;
	const hct = Hct.fromInt(argbFromHex(fg));
	const dir = relLum(bg) > 0.18 ? -1 : 1;
	let out = fg;
	for (let t = hct.tone + dir * 3; t >= 0 && t <= 100; t += dir * 3) {
		out = hexFromArgb(Hct.from(hct.hue, hct.chroma, t).toInt());
		if (contrast(out, bg) >= min) return out;
	}
	return out;
}

// Port of the app's palette pipeline (ColorSchemeUtil.generateColorPalette,
// ColorModifiers.modifyColors, CommunityThemePalette.derive, DynamicColors).
// Order matters: palette, then modifiers, then the theme's own hexes, then
// pitch black. Roles read fixed indices out of the finished palette.
const TONES = [100, 99, 95, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const TINTS = TONES.map((t) => t / 100);
const SHADES = [
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
const ROW_NAMES = [
	"system_accent1",
	"system_accent2",
	"system_accent3",
	"system_neutral1",
	"system_neutral2",
	"system_error",
];

// [row, darkIndex, lightIndex, darkLightnessAdjustment, lightLightnessAdjustment]
const ROLE_MAP = {
	primary: [0, 4, 8],
	primaryContainer: [0, 9, 3],
	onPrimaryContainer: [0, 3, 11],
	onPrimary: [0, 10, 0],
	secondaryContainer: [1, 9, 3],
	onSecondaryContainer: [1, 3, 11],
	tertiary: [2, 4, 8],
	surface: [3, 11, 1, -25, -1],
	onSurface: [3, 2, 10],
	surfaceContainer: [3, 10, 2, -42, -2],
	surfaceContainerHigh: [3, 10, 1, null, -4],
	surfaceContainerHighest: [3, 10, 1, 3, -5],
	surfaceBright: [3, 10, 1, 13, -2],
	onSurfaceVariant: [4, 2, 10],
	outlineVariant: [4, 9, 4],
};

function toneOf(hex) {
	return Hct.fromInt(argbFromHex(hex)).tone;
}

function atTone(hex, tone) {
	const h = Hct.fromInt(argbFromHex(hex));
	return hexFromArgb(
		Hct.from(h.hue, h.chroma, Math.max(0, Math.min(100, tone))).toInt(),
	);
}

function shiftLightness(hex, lightness, idx) {
	let f = (lightness - 100) / 1000;
	if (idx === 0 || idx === 12) f = 0;
	else if (idx === 1) f /= 10;
	else if (idx === 2) f /= 2;
	return atTone(hex, 100 * (TINTS[idx] + f));
}

function adjustLightness(hex, percent) {
	const tone = toneOf(hex);
	const pct = Math.max(-100, Math.min(100, percent));
	return atTone(hex, tone + tone * (pct / 100));
}

function buildRows(seedHex, style, spec, dark, sliders, theme) {
	const Ctor = SCHEME_BY_STYLE[style] ?? SchemeTonalSpot;
	const toneList = (palette) =>
		TONES.map((t) => hexFromArgb(palette.tone(t)));
	const scheme = new Ctor(Hct.fromInt(argbFromHex(seedHex)), dark, 0, spec);
	const rows = [
		scheme.primaryPalette,
		scheme.secondaryPalette,
		scheme.tertiaryPalette,
		scheme.neutralPalette,
		scheme.neutralVariantPalette,
		scheme.errorPalette,
	].map(toneList);

	const ownPalette = (hex) =>
		toneList(
			new Ctor(Hct.fromInt(argbFromHex(hex)), dark, 0, spec)
				.primaryPalette,
		);
	if (HEX_COLOR.test(theme?.secondaryColor ?? "")) {
		rows[1] = ownPalette(theme.secondaryColor);
	}
	if (HEX_COLOR.test(theme?.tertiaryColor ?? "")) {
		rows[2] = ownPalette(theme.tertiaryColor);
	}

	const { accentSat, bgSat, bgLight } = sliders;
	const mono = style === "MONOCHROMATIC";
	const rainbow = style === "RAINBOW";
	const pitch = Boolean(theme?.pitchBlack);

	rows.forEach((row, i) => {
		const accent = i <= 2 || i === 5;
		const neutral = i === 3 || i === 4;
		// The app modifies shades 1..12; shade 0 is left alone.
		for (let j = 1; j < row.length; j++) {
			if (accent && accentSat !== 100 && !mono) {
				row[j] = adjustSaturation(row[j], accentSat);
			} else if (neutral) {
				if (bgLight !== 100 && !mono) {
					row[j] = shiftLightness(row[j], bgLight, j);
				}
				if (bgSat !== 100 && !mono && !rainbow) {
					row[j] = adjustSaturation(row[j], bgSat);
				}
			}
			if (mono) row[j] = shiftLightness(row[j], bgLight, j);
		}
		if (neutral && pitch) row[11] = "#000000";
	});

	for (const [name, hex] of Object.entries(theme?.colorOverrides ?? {})) {
		if (!HEX_COLOR.test(hex)) continue;
		const cut = name.lastIndexOf("_");
		const row = ROW_NAMES.indexOf(name.slice(0, cut));
		const idx = SHADES.indexOf(name.slice(cut + 1));
		if (row >= 0 && idx >= 0) rows[row][idx] = hex;
	}

	if (pitch) {
		rows[3][11] = "#000000";
		rows[4][11] = "#000000";
	}

	return rows;
}

function roleReader(rows, dark) {
	return (name) => {
		const [row, darkIdx, lightIdx, darkAdj, lightAdj] = ROLE_MAP[name];
		const hex = rows[row][dark ? darkIdx : lightIdx];
		const adj = dark ? darkAdj : lightAdj;
		return adj == null ? hex : adjustLightness(hex, adj);
	};
}

// Slider values for the active mode; the app ignores them for MONOCHROMATIC.
function themeSliders(theme, isDark) {
	if (!theme || theme.style === "MONOCHROMATIC") {
		return { accentSat: 100, bgSat: 100, bgLight: 100 };
	}
	const light = !isDark && theme.modeSpecificThemes;
	return {
		accentSat:
			(light ? theme.accentSaturationLight : theme.accentSaturation) ??
			100,
		bgSat:
			(light
				? theme.backgroundSaturationLight
				: theme.backgroundSaturation) ?? 100,
		bgLight:
			(light
				? theme.backgroundLightnessLight
				: theme.backgroundLightness) ?? 100,
	};
}

export default {
	async fetch(request, env, ctx) {
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
				return await admin(request, url, env, ctx);
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

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	// Rate limit across all themes by device OR ip so neither device
	// rotation nor a VPN unlocks unlimited reports.
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	const recent = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM reports WHERE (device = ? OR ip = ?) AND created > ?",
	)
		.bind(device, ip, dayAgo)
		.first();
	if ((recent?.c ?? 0) >= MAX_REPORTS_PER_DAY) {
		return json({ error: "rate limited" }, 429);
	}

	// Same identity (device OR ip) reports a theme at most once.
	const existing = await env.DB.prepare(
		"SELECT 1 FROM reports WHERE theme_id = ? AND (device = ? OR ip = ?)",
	)
		.bind(themeId, device, ip)
		.first();
	if (existing) return json({ reported: true });

	await env.DB.prepare(
		"INSERT INTO reports (theme_id, device, ip, created) VALUES (?, ?, ?, ?)",
	)
		.bind(themeId, device, ip, Date.now())
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

	// Counts of 1000+ collapse to 1K / 1.1K, matching the site's cards.
	// Truncated, never rounded up, so the shown figure is never ahead of the
	// real one.
	const compact = (n) => {
		const value = Number(n) || 0;
		if (value < 1000) return String(value);
		const [unit, divisor] = value < 1e6 ? ["K", 1e3] : ["M", 1e6];
		const scaled = Math.floor((value / divisor) * 10) / 10;
		return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${unit}`;
	};

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

	const spec = SPEC_BY_VERSION[theme.colorSpecVersion] ?? DEFAULT_SPEC;

	const buildPalette = (isDark) => {
		const rows = buildRows(
			seed,
			theme.style ?? "TONAL_SPOT",
			spec,
			isDark,
			themeSliders(theme, isDark),
			theme,
		);
		const role = roleReader(rows, isDark);
		const at = (row, tone) => rows[row][TONES.indexOf(tone)];

		const accent = role("primary");
		const tonal = role("primaryContainer");
		const colors = {
			bg: role("surface"),
			text: role("onSurface"),
			subtle: alpha(role("onSurfaceVariant"), 0.9),
			body2: role("onSurfaceVariant"),
			accent,
			"on-accent": ensureContrast(role("onPrimary"), accent),
			card: role("surfaceContainer"),
			"card-high": role("surfaceContainerHigh"),
			tonal,
			"on-tonal": ensureContrast(role("onPrimaryContainer"), tonal),
			"outline-v": role("outlineVariant"),
			swHalf: at(0, 80),
			swQ1: at(2, 70),
			swQ2: at(1, 60),
			swSquare: at(4, 30),
			swCenter: seed,
		};
		return { rows, colors };
	};

	const dark = buildPalette(true);
	const lightMode = buildPalette(false);
	// Launcher gradient stops; a single favicon, so the dark palette drives it.
	const logoStops = [dark.rows[0][4], dark.rows[0][8]];
	const cssVars = (c) =>
		Object.entries(c)
			.map(([k, v]) => `--${k}: ${v};`)
			.join(" ");

	// SVG twin of the app's WallColorPreviewCanvas (64 box, pad 8, corner 16,
	// dot r13), same geometry the gallery cards use. Fills are CSS vars so
	// the light-mode override swaps the whole swatch.
	const swatch = `<svg class="tswatch" viewBox="0 0 64 64" role="img" aria-label="Theme color preview">
    <rect width="64" height="64" rx="16" fill="var(--swSquare)"/>
    <path d="M8 32 A24 24 0 0 1 56 32 Z" fill="var(--swHalf)"/>
    <path d="M32 32 L32 56 A24 24 0 0 1 8 32 Z" fill="var(--swQ1)"/>
    <path d="M32 32 L56 32 A24 24 0 0 1 32 56 Z" fill="var(--swQ2)"/>
    <circle cx="32" cy="32" r="13" fill="var(--swCenter)"/>
    <rect class="ring" x=".5" y=".5" width="63" height="63" rx="15.5" fill="none"/>
  </svg>`;

	// Favicon = ColorBlendr launcher mark (drop + swoosh) on a seed-tinted
	// gradient disc, mirroring the app icon's dynamic background.
	const favicon =
		"data:image/svg+xml," +
		encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
				`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
				`<stop offset="0" stop-color="${logoStops[0]}"/>` +
				`<stop offset="1" stop-color="${logoStops[1]}"/>` +
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
  }
  @media (prefers-color-scheme: light) {
    :root { ${cssVars(lightMode.colors)} }
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
    border: 1px solid var(--outline-v);
    box-shadow: 0 30px 70px rgba(0, 0, 0, .45);
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
    font-size: 13px; font-weight: 600; color: var(--subtle); margin-bottom: 28px;
  }
  /* .card > * sets fadeup on every child and :nth-child(2) sets its delay,
     both (0,2,0); matching that specificity here keeps pop and its delay. */
  .card > .tswatch {
    display: block; width: 104px; height: 104px; margin: 0 auto 20px;
    animation: pop .55s cubic-bezier(.2,.7,.2,1) .12s backwards;
    transition: transform .25s cubic-bezier(.2,.7,.2,1);
  }
  .tswatch:hover { transform: scale(1.06) rotate(-3deg); }
  /* Near-black neutral squares (or overridden ones) sit on a near-black card
     and lose their edge; the ring keeps the tile readable in both modes. */
  .tswatch .ring {
    stroke: color-mix(in srgb, var(--text) 22%, transparent);
    stroke-width: 1;
  }
  h1 { margin: 0 0 6px; font-size: clamp(26px, 7vw, 32px); font-weight: 800; letter-spacing: -.03em; }
  .author { color: var(--subtle); margin: 0 0 16px; font-size: 14px; }
  .desc { color: var(--body2); font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
  .chips { display: flex; gap: 8px; justify-content: center; margin-bottom: 28px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 999px;
    background: var(--card-high); color: var(--body2);
    font-size: 13px; font-weight: 600;
    transition: transform .2s cubic-bezier(.2,.7,.2,1);
  }
  .chip:hover { transform: translateY(-2px); }
  .chip svg { display: block; }
  a.btn {
    display: flex; align-items: center; justify-content: center; gap: 9px;
    padding: 16px 26px; border-radius: 999px; text-decoration: none;
    font-size: 15px; font-weight: 600; line-height: 1;
    transition: filter .15s ease, transform .12s ease,
                border-radius .25s cubic-bezier(.2,.7,.2,1);
  }
  a.btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
  a.btn:active { transform: scale(.97); border-radius: 18px; }
  .open { background: var(--accent); color: var(--on-accent); }
  .get { background: var(--tonal); color: var(--on-tonal); margin-top: 10px; }
  @media (prefers-reduced-motion: reduce) {
    .card, .card > * { animation: none; }
    .tswatch, .chip, a.btn { transition: none; }
  }
</style>
</head>
<body>
<main class="card">
  <div class="brand">ColorBlendr Community</div>
  ${swatch}
  <h1>${esc(theme.name)}</h1>
  <p class="author">by ${esc(theme.author || "Anonymous")}</p>
  <p class="desc">${esc(theme.description)}</p>
  <div class="chips">
    <span class="chip">${thumbIcon}${compact(theme.upvotes)}</span>
    <span class="chip">${downloadIcon}${compact(theme.downloads)}</span>
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

// Pushes an elevation tier off the tone of the one below it when a theme's
// overrides flatten the ramp. dir: +1 dark (tiers get lighter), -1 light.

// Port of the app's CAM16 lightness slider (ColorUtil.shiftLightness) with
// optional tone bounds so page surfaces never collapse to black/white.

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

	// Only real themes get rows, so votes can't be inflated for fake ids.
	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	// Identity = device OR ip, so a VPN (new ip, same device) and device
	// rotation (same ip, new device) both resolve to the existing vote.
	const existing = await env.DB.prepare(
		"SELECT 1 FROM votes WHERE theme_id = ? AND (device = ? OR ip = ?)",
	)
		.bind(themeId, device, ip)
		.first();

	if (existing) {
		await env.DB.prepare(
			"DELETE FROM votes WHERE theme_id = ? AND (device = ? OR ip = ?)",
		)
			.bind(themeId, device, ip)
			.run();
	} else {
		await env.DB.prepare(
			"INSERT INTO votes (theme_id, device, ip, created) VALUES (?, ?, ?, ?)",
		)
			.bind(themeId, device, ip, Date.now())
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

	// Only real themes get rows, so downloads can't be inflated for fake ids.
	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	// One download per identity (device OR ip) per theme.
	const existing = await env.DB.prepare(
		"SELECT 1 FROM applies WHERE theme_id = ? AND (device = ? OR ip = ?)",
	)
		.bind(themeId, device, ip)
		.first();
	if (!existing) {
		await env.DB.prepare(
			"INSERT INTO applies (theme_id, device, ip, created) VALUES (?, ?, ?, ?)",
		)
			.bind(themeId, device, ip, Date.now())
			.run();
	}

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

	const name = clean(p.name, MAX_NAME);
	if (!name) return null;
	const description = cleanMultiline(p.description ?? "", MAX_DESCRIPTION);
	if (!description) return null;
	const author = clean(p.author ?? "", MAX_NAME);

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

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	const recent = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM uploads WHERE (device = ? OR ip = ?) AND created > ?",
	)
		.bind(device, ip, dayAgo)
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

	await env.DB.prepare(
		"INSERT INTO uploads (device, ip, created) VALUES (?, ?, ?)",
	)
		.bind(device, ip, Date.now())
		.run();

	// uploads is a pure 24h rate-limit ledger; drop rows past the window so
	// device/IP rotation spam can't grow the table without bound.
	await env.DB.prepare("DELETE FROM uploads WHERE created < ?")
		.bind(dayAgo)
		.run();

	return json({ queued: true });
}

const MAX_ADMIN_FAILURES_PER_HOUR = 5;
// GitHub throttles bursts of writes to one repo; two approvals tapped
// together collide here. Retry on the throttle instead of losing the PR.
const GITHUB_MAX_RETRIES = 3;
const GITHUB_MAX_BACKOFF_MS = 10000;

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
async function admin(request, url, env, ctx) {
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

		// Optional admin rewrite of the submitted text. Same limits as
		// /upload; the id keeps its original slug so approve stays
		// idempotent (same branch, same PR) across retries.
		const nameEdit =
			body?.name === undefined ? null : clean(body.name, MAX_NAME);
		const descriptionEdit =
			body?.description === undefined
				? null
				: cleanMultiline(body.description, MAX_DESCRIPTION);
		if (
			(body?.name !== undefined && !nameEdit) ||
			(body?.description !== undefined && !descriptionEdit)
		) {
			return json({ error: "bad request" }, 400);
		}

		const row = await env.DB.prepare(
			"SELECT name, payload FROM pending WHERE id = ?",
		)
			.bind(id)
			.first();
		if (!row) return json({ error: "not found" }, 404);

		const payload = JSON.parse(row.payload);
		if (nameEdit) payload.name = nameEdit;
		if (descriptionEdit) payload.description = descriptionEdit;
		const themeName = nameEdit ?? row.name;
		const themeJson = JSON.stringify(
			{ id, ...payload, createdAt: Math.floor(Date.now() / 1000) },
			null,
			2,
		);
		// waitUntil keeps this alive if the admin app disconnects mid-call —
		// otherwise an aborted request strands a branch with no PR and the
		// queue row survives, so the theme reappears in the review list.
		const work = (async () => {
			const prUrl = await openPullRequest(env, id, themeName, themeJson);
			if (prUrl) {
				await env.DB.prepare("DELETE FROM pending WHERE id = ?")
					.bind(id)
					.run();
			}
			return prUrl;
		})();
		ctx?.waitUntil?.(work);

		const prUrl = await work;
		if (!prUrl) return json({ error: "github error" }, 502);
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

// Every step tolerates its own output already being there, so a half-done
// approve (branch made, PR not) finishes on the next try instead of dying
// on a 422 "already exists". Same theme approved twice -> same PR url.
async function openPullRequest(env, id, themeName, themeJson) {
	const gh = (path, init) => githubFetch(env, path, init);
	const branch = `theme/${id}`;
	const path = `themes/${id}.json`;
	const owner = env.GITHUB_REPO.split("/")[0];

	// Already merged: nothing left to open, but the caller must still drop
	// the queue row, so report success.
	const merged = await gh(`/contents/${path}?ref=main`);
	if (merged.ok) {
		return `https://github.com/${env.GITHUB_REPO}/blob/main/${path}`;
	}

	const main = await (await gh("/git/ref/heads/main")).json();
	const baseSha = main?.object?.sha;
	if (!baseSha) return null;

	const created = await gh("/git/refs", {
		method: "POST",
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
	});
	// 422 = ref exists from an earlier attempt; reuse it.
	if (!created.ok && created.status !== 422) return null;

	// Keep the earlier commit if there is one — rewriting it would only
	// churn createdAt.
	const existing = await gh(`/contents/${path}?ref=${branch}`);
	if (!existing.ok) {
		const file = await gh(`/contents/${path}`, {
			method: "PUT",
			body: JSON.stringify({
				message: `Add theme: ${themeName}`,
				content: btoa(unescape(encodeURIComponent(themeJson))),
				branch,
			}),
		});
		if (!file.ok) return null;
	}

	const open = await gh(`/pulls?head=${owner}:${branch}&state=open`);
	if (open.ok) {
		const url = (await open.json().catch(() => null))?.[0]?.html_url;
		if (url) return url;
	}

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

// Retries only the throttle responses (429, or 403 carrying rate-limit
// headers) — a 403 from a bad token still fails fast.
async function githubFetch(env, path, init = {}, attempt = 0) {
	const response = await fetch(
		`https://api.github.com/repos/${env.GITHUB_REPO}${path}`,
		{
			...init,
			headers: {
				authorization: `Bearer ${env.GITHUB_TOKEN}`,
				accept: "application/vnd.github+json",
				"user-agent": "colorblendr-themes-worker",
				...init.headers,
			},
		},
	);

	const retryAfter = response.headers.get("retry-after");
	const throttled =
		response.status === 429 ||
		(response.status === 403 &&
			(retryAfter !== null ||
				response.headers.get("x-ratelimit-remaining") === "0"));
	if (!throttled || attempt >= GITHUB_MAX_RETRIES) return response;

	const wait = Number(retryAfter) * 1000 || (attempt + 1) * 2000;
	await new Promise((resolve) =>
		setTimeout(resolve, Math.min(wait, GITHUB_MAX_BACKOFF_MS)),
	);
	return githubFetch(env, path, init, attempt + 1);
}
