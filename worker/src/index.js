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
const COUNTS_CACHE_SECONDS = 600;
const MAX_UPLOADS_PER_DAY = 3;
const MAX_REPORTS_PER_DAY = 3;

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
		for (const row of [3, 4]) {
			rows[row][11] = "#000000";
			rows[row][10] = atTone(rows[row][10], 8);
		}
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
				return await vote(request, env, ctx);
			}
			if (request.method === "GET" && url.pathname === "/votes") {
				return await votesForDevice(url, env);
			}
			if (request.method === "POST" && url.pathname === "/download") {
				return await download(request, env, ctx);
			}
			if (request.method === "GET" && url.pathname === "/counts") {
				return await counts(request, env, ctx);
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
				return await themePage(url, env, ctx);
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: "internal" }, 500);
		}
	},
};

async function report(request, env) {
	const body = await request.json().catch(() => null);
	const themeId = body?.themeId;
	const device = body?.device;
	if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
		return json({ error: "bad request" }, 400);
	}

	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	const recent = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM reports WHERE (device = ? OR ip = ?) AND created > ?",
	)
		.bind(device, ip, dayAgo)
		.first();
	if ((recent?.c ?? 0) >= MAX_REPORTS_PER_DAY) {
		return json({ error: "rate limited" }, 429);
	}

	if (await identityExists("reports", themeId, device, ip, env)) {
		return json({ reported: true });
	}

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

async function themePage(url, env, ctx) {
	const id = url.pathname.slice("/theme/".length);
	if (!ID_REGEX.test(id)) return new Response("Not found", { status: 404 });

	const cache = caches.default;
	const cacheKey = new Request(`${url.origin}/theme/${id}`);
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	const cached = local ? null : await cache.match(cacheKey);
	if (cached) return cached;

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

	const compact = (n) => {
		const value = Number(n) || 0;
		if (value < 1000) return String(value);
		const [unit, divisor] = value < 1e6 ? ["K", 1e3] : ["M", 1e6];
		const scaled = Math.floor((value / divisor) * 10) / 10;
		return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${unit}`;
	};

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

	const GALLERY = "https://mahmud0808.github.io/ColorBlendr-Themes/";

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
		const secC = role("secondaryContainer");

		const surface = role("surface");
		const surfaceTone = toneOf(surface);
		const elevated = (name, floor) => {
			const hex = role(name);
			if (!isDark) return hex;
			const min = surfaceTone + floor;
			return toneOf(hex) >= min ? hex : atTone(hex, min);
		};

		const colors = {
			bg: surface,
			text: role("onSurface"),
			subtle: alpha(role("onSurfaceVariant"), 0.9),
			body2: role("onSurfaceVariant"),
			accent,
			"on-accent": ensureContrast(role("onPrimary"), accent),
			"card-high": elevated("surfaceContainerHigh", 7),
			tonal,
			"on-tonal": ensureContrast(role("onPrimaryContainer"), tonal),
			"sec-c": secC,
			"on-sec-c": ensureContrast(role("onSecondaryContainer"), secC),
			swHalf: at(0, 80),
			swQ1: at(2, 70),
			swQ2: at(1, 60),
			swSquare: at(4, 30),
			swCenter: seed,
		};
		rows[0].forEach((hex, idx) => {
			colors[`r${idx}`] = hex;
			colors[`o${idx}`] = relLum(hex) > 0.2 ? "#0a0e12c7" : "#ffffffe0";
		});
		return { rows, colors };
	};

	const dark = buildPalette(true);
	const lightMode = buildPalette(false);
	const logoStops = [dark.rows[0][4], dark.rows[0][8]];
	const cssVars = (c) =>
		Object.entries(c)
			.map(([k, v]) => `--${k}:${v};`)
			.join("");

	const styleName = String(theme.style ?? "TONAL_SPOT")
		.toLowerCase()
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

	const swatch = `<svg class="sw" viewBox="0 0 64 64" role="img" aria-label="Theme color preview"><rect width="64" height="64" rx="16" fill="var(--swSquare)"/><path d="M8 32A24 24 0 0 1 56 32Z" fill="var(--swHalf)"/><path d="M32 32L32 56A24 24 0 0 1 8 32Z" fill="var(--swQ1)"/><path d="M32 32L56 32A24 24 0 0 1 32 56Z" fill="var(--swQ2)"/><circle cx="32" cy="32" r="13" fill="var(--swCenter)"/><rect x=".5" y=".5" width="63" height="63" rx="15.5" fill="none" stroke="currentColor" stroke-opacity=".22"/></svg>`;

	const logoMark =
		`<g transform="translate(50,50) scale(1.5) translate(-50,-50) translate(26.777779,26.777779) scale(0.46444446)">` +
		`<path fill="#fff" fill-opacity="0.4" d="M86.2,66.5Q86.8,61.7 86.1,57.2C104.3,66.1 106.8,81 82,81C59.7,81 29.9,74.8 10,61.2C-4.9,51.2 -4.9,38.8 21.2,39Q18.6,43.1 17.3,46.2Q0.1,46 12.8,54.6C34.8,68.6 62.1,73.6 84.5,74.4Q99.4,74.4 86.2,66.5z"/>` +
		`<path fill="#fff" fill-opacity="0.902" d="M82.6,70.2C56.5,68.5 34.3,62.5 18,52.5C20,43.5 33,24 49.8,6.6C72.5,31.5 88.3,50.5 82.6,70.2zM73.4,84.7C56,101 24,94 17.2,70.3C30.8,78.5 48.7,83.6 73.4,84.7z"/>` +
		`</g>`;
	const logo = (a, b) =>
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:${a}"/><stop offset="1" style="stop-color:${b}"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/>${logoMark}</svg>`;
	const favicon = "data:image/svg+xml," + encodeURIComponent(logo(...logoStops));

	const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
	const ramp = SHADES.map(
		(shade, idx) => `<span style="--c:var(--r${idx});--o:var(--o${idx})"><em>${shade}</em></span>`,
	).join("");

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
@font-face{font-family:"Google Sans Flex";src:url("${GALLERY}assets/fonts/google-sans-flex.woff2") format("woff2");font-weight:100 1000;font-display:swap}
:root{color-scheme:dark;${cssVars(dark.colors)}--morph:cubic-bezier(.2,0,0,1);--ease:cubic-bezier(.2,.7,.2,1);--g:clamp(20px,4.5vw,48px);--ck:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Cpath d='M100.0 4.0 L102.5 4.3 L105.0 5.1 L107.4 6.4 L109.7 8.0 L111.9 9.8 L114.0 11.7 L116.0 13.4 L118.1 15.0 L120.1 16.1 L122.3 16.9 L124.5 17.3 L126.9 17.3 L129.4 17.0 L132.1 16.5 L134.8 15.9 L137.6 15.5 L140.4 15.2 L143.1 15.3 L145.7 15.8 L148.0 16.9 L150.0 18.4 L151.8 20.3 L153.2 22.6 L154.4 25.1 L155.4 27.8 L156.3 30.5 L157.2 33.0 L158.2 35.4 L159.4 37.4 L160.8 39.2 L162.6 40.6 L164.6 41.8 L167.0 42.8 L169.5 43.7 L172.2 44.6 L174.9 45.6 L177.4 46.8 L179.7 48.2 L181.6 50.0 L183.1 52.0 L184.2 54.3 L184.7 56.9 L184.8 59.6 L184.5 62.4 L184.1 65.2 L183.5 67.9 L183.0 70.6 L182.7 73.1 L182.7 75.5 L183.1 77.7 L183.9 79.9 L185.0 81.9 L186.6 84.0 L188.3 86.0 L190.2 88.1 L192.0 90.3 L193.6 92.6 L194.9 95.0 L195.7 97.5 L196.0 100.0 L195.7 102.5 L194.9 105.0 L193.6 107.4 L192.0 109.7 L190.2 111.9 L188.3 114.0 L186.6 116.0 L185.0 118.1 L183.9 120.1 L183.1 122.3 L182.7 124.5 L182.7 126.9 L183.0 129.4 L183.5 132.1 L184.1 134.8 L184.5 137.6 L184.8 140.4 L184.7 143.1 L184.2 145.7 L183.1 148.0 L181.6 150.0 L179.7 151.8 L177.4 153.2 L174.9 154.4 L172.2 155.4 L169.5 156.3 L167.0 157.2 L164.6 158.2 L162.6 159.4 L160.8 160.8 L159.4 162.6 L158.2 164.6 L157.2 167.0 L156.3 169.5 L155.4 172.2 L154.4 174.9 L153.2 177.4 L151.8 179.7 L150.0 181.6 L148.0 183.1 L145.7 184.2 L143.1 184.7 L140.4 184.8 L137.6 184.5 L134.8 184.1 L132.1 183.5 L129.4 183.0 L126.9 182.7 L124.5 182.7 L122.3 183.1 L120.1 183.9 L118.1 185.0 L116.0 186.6 L114.0 188.3 L111.9 190.2 L109.7 192.0 L107.4 193.6 L105.0 194.9 L102.5 195.7 L100.0 196.0 L97.5 195.7 L95.0 194.9 L92.6 193.6 L90.3 192.0 L88.1 190.2 L86.0 188.3 L84.0 186.6 L81.9 185.0 L79.9 183.9 L77.7 183.1 L75.5 182.7 L73.1 182.7 L70.6 183.0 L67.9 183.5 L65.2 184.1 L62.4 184.5 L59.6 184.8 L56.9 184.7 L54.3 184.2 L52.0 183.1 L50.0 181.6 L48.2 179.7 L46.8 177.4 L45.6 174.9 L44.6 172.2 L43.7 169.5 L42.8 167.0 L41.8 164.6 L40.6 162.6 L39.2 160.8 L37.4 159.4 L35.4 158.2 L33.0 157.2 L30.5 156.3 L27.8 155.4 L25.1 154.4 L22.6 153.2 L20.3 151.8 L18.4 150.0 L16.9 148.0 L15.8 145.7 L15.3 143.1 L15.2 140.4 L15.5 137.6 L15.9 134.8 L16.5 132.1 L17.0 129.4 L17.3 126.9 L17.3 124.5 L16.9 122.3 L16.1 120.1 L15.0 118.1 L13.4 116.0 L11.7 114.0 L9.8 111.9 L8.0 109.7 L6.4 107.4 L5.1 105.0 L4.3 102.5 L4.0 100.0 L4.3 97.5 L5.1 95.0 L6.4 92.6 L8.0 90.3 L9.8 88.1 L11.7 86.0 L13.4 84.0 L15.0 81.9 L16.1 79.9 L16.9 77.7 L17.3 75.5 L17.3 73.1 L17.0 70.6 L16.5 67.9 L15.9 65.2 L15.5 62.4 L15.2 59.6 L15.3 56.9 L15.8 54.3 L16.9 52.0 L18.4 50.0 L20.3 48.2 L22.6 46.8 L25.1 45.6 L27.8 44.6 L30.5 43.7 L33.0 42.8 L35.4 41.8 L37.4 40.6 L39.2 39.2 L40.6 37.4 L41.8 35.4 L42.8 33.0 L43.7 30.5 L44.6 27.8 L45.6 25.1 L46.8 22.6 L48.2 20.3 L50.0 18.4 L52.0 16.9 L54.3 15.8 L56.9 15.3 L59.6 15.2 L62.4 15.5 L65.2 15.9 L67.9 16.5 L70.6 17.0 L73.1 17.3 L75.5 17.3 L77.7 16.9 L79.9 16.1 L81.9 15.0 L84.0 13.4 L86.0 11.7 L88.1 9.8 L90.3 8.0 L92.6 6.4 L95.0 5.1 L97.5 4.3Z'/%3E%3C/svg%3E")}
@media (prefers-color-scheme:light){:root{color-scheme:light;${cssVars(lightMode.colors)}}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;font:16px/1.6 "Google Sans Flex",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;overflow-x:clip}
::selection{background:var(--accent);color:var(--on-accent)}
a{color:inherit;text-decoration:none}
a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.w{width:100%;max-width:1200px;margin-inline:auto;padding-inline:var(--g)}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;height:72px}
.brand{display:flex;align-items:center;gap:11px;font-size:19px;font-weight:720;letter-spacing:-.02em;border-radius:12px}
.brand svg{width:34px;height:34px}
.nav{display:flex;align-items:center;height:44px;padding:0 20px;border-radius:22px;background:var(--card-high);font-size:15px;font-weight:650;transition:border-radius .4s var(--morph)}
main{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);align-items:center;gap:clamp(28px,5vw,72px);padding-block:clamp(28px,5vw,72px) clamp(48px,6vw,88px)}
h1{margin:0 0 18px;font-size:clamp(48px,7.6vw,108px);font-weight:780;letter-spacing:-.055em;word-spacing:.08em;line-height:.92;overflow-wrap:anywhere;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:0 0 22px;color:var(--body2);font-size:15px}
.meta b{color:var(--text);font-weight:650}
.tag{padding:6px 12px;border-radius:12px;background:var(--card-high);color:var(--text);font-weight:600}
.desc{margin:0 0 30px;max-width:46ch;color:var(--body2);font-size:clamp(17px,1.5vw,20px);text-wrap:pretty}
.stats{display:flex;gap:12px;margin-bottom:34px}
.stat{display:flex;flex-direction:column;gap:10px;min-width:140px;padding:20px 26px;border-radius:30px;transition:border-radius .5s var(--morph)}
.stat b{font-size:clamp(38px,4.2vw,56px);font-weight:780;letter-spacing:-.05em;line-height:.9;font-variant-numeric:tabular-nums}
.stat span{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:600}
.stat svg{width:16px;height:16px;fill:currentColor}
.pri{background:var(--tonal);color:var(--on-tonal)}
.sec{background:var(--sec-c);color:var(--on-sec-c)}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:18px 28px}
.btn{display:flex;align-items:center;gap:10px;height:60px;padding:0 30px;border-radius:20px;background:var(--accent);color:var(--on-accent);font-size:16.5px;font-weight:650;transition:border-radius .45s var(--morph),transform .2s var(--ease)}
.btn svg{width:21px;height:21px;fill:currentColor}
.btn:active{transform:scale(.96)}
.link{padding-block:6px;font-size:16.5px;font-weight:650;border-bottom:2.5px solid var(--accent)}
.note{flex-basis:100%;margin:0;color:var(--subtle);font-size:14px}
.art{position:relative;display:grid;place-items:center;aspect-ratio:1;color:var(--text)}
.art::before{content:"";position:absolute;inset:0;background:var(--tonal);-webkit-mask:var(--ck) center/contain no-repeat;mask:var(--ck) center/contain no-repeat;animation:spin 60s linear infinite}
@keyframes spin{to{rotate:360deg}}
.sw{position:relative;width:56%;height:auto;filter:drop-shadow(0 24px 32px #0005);transition:transform .6s cubic-bezier(.34,1.45,.64,1)}
.ramp{display:flex;height:clamp(72px,9vw,120px);margin-top:auto}
.ramp span{position:relative;flex:1 1 0;min-width:0;background:var(--c);transition:flex-grow .5s cubic-bezier(.34,1.45,.64,1)}
.ramp em{position:absolute;left:clamp(4px,1vw,14px);bottom:clamp(8px,1.2vw,16px);color:var(--o);font:650 clamp(9px,1vw,13px)/1 ui-monospace,Consolas,monospace}
@media (hover:hover) and (pointer:fine){.nav:hover{border-radius:14px}.btn:hover{border-radius:30px}.stat:hover{border-radius:50px}.art:hover .sw{transform:scale(1.05) rotate(-6deg)}.ramp span:hover{flex-grow:2.6}}
@media (max-width:860px){main{grid-template-columns:minmax(0,1fr)}.art{width:min(100%,380px);justify-self:center}}
@media (max-width:480px){.stat{min-width:0;flex:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<header class="w">
<a class="brand" href="${GALLERY}">${logo("var(--r4)", "var(--r8)")}ColorBlendr</a>
<a class="nav" href="${GALLERY}themes.html">All themes</a>
</header>
<main class="w">
<div>
<h1>${esc(theme.name)}</h1>
<p class="meta"><span>by <b>${esc(theme.author || "Anonymous")}</b></span><span class="tag">${esc(styleName)}</span></p>
<p class="desc">${esc(theme.description)}</p>
<div class="stats">
<div class="stat pri"><b>${compact(theme.upvotes)}</b><span>${icon("M13.12 2.06 7.58 7.6c-.37.37-.58.88-.58 1.41V19c0 1.1.9 2 2 2h9c.8 0 1.52-.48 1.84-1.21l3.26-7.61C23.94 10.2 22.49 8 20.34 8h-5.65l.95-4.58c.1-.5-.05-1.01-.41-1.37-.59-.58-1.53-.58-2.11.01ZM3 21c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2s-2 .9-2 2v8c0 1.1.9 2 2 2Z")}votes</span></div>
<div class="stat sec"><b>${compact(theme.downloads)}</b><span>${icon("M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71ZM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1Z")}applies</span></div>
</div>
<div class="cta">
<a class="btn" href="colorblendr://theme/${esc(id)}">${icon("M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z")}Open in ColorBlendr</a>
<a class="link" href="https://mahmud0808.github.io/ColorBlendr/">Get the app</a>
<p class="note">Opening needs ColorBlendr installed on your phone.</p>
</div>
</div>
<div class="art">${swatch}</div>
</main>
<div class="ramp" aria-hidden="true">${ramp}</div>
</body>
</html>`;

	const response = new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	});
	if (!local) ctx?.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

function adjustSaturation(hex, saturation) {
	if (saturation === 100) return hex;
	const satF = (saturation - 100) / 100;
	const hct = Hct.fromInt(argbFromHex(hex));
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

async function vote(request, env, ctx) {
	const body = await request.json().catch(() => null);
	const themeId = body?.themeId;
	const device = body?.device;
	if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
		return json({ error: "bad request" }, 400);
	}

	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	const existing = await identityExists("votes", themeId, device, ip, env);

	if (existing) {
		const deleted = await env.DB.prepare(
			"DELETE FROM votes WHERE theme_id = ? AND (device = ? OR ip = ?)",
		)
			.bind(themeId, device, ip)
			.run();
		const removed = deleted.meta?.changes ?? 0;
		if (removed > 0) {
			await env.DB.prepare(
				"UPDATE theme_counts SET votes = MAX(votes - ?, 0) WHERE theme_id = ?",
			)
				.bind(removed, themeId)
				.run();
		}
	} else {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO votes (theme_id, device, ip, created) VALUES (?, ?, ?, ?)",
			).bind(themeId, device, ip, Date.now()),
			env.DB.prepare(
				"INSERT INTO theme_counts (theme_id, votes, applies) VALUES (?, 1, 0) " +
					"ON CONFLICT(theme_id) DO UPDATE SET votes = votes + 1",
			).bind(themeId),
		]);
	}

	purgeCounts(request, ctx);

	const count = await env.DB.prepare(
		"SELECT votes AS c FROM theme_counts WHERE theme_id = ?",
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

async function download(request, env, ctx) {
	const body = await request.json().catch(() => null);
	const themeId = body?.themeId;
	const device = body?.device;
	if (!ID_REGEX.test(themeId ?? "") || !DEVICE_REGEX.test(device ?? "")) {
		return json({ error: "bad request" }, 400);
	}

	if (!(await themeExists(themeId, env))) {
		return json({ error: "not found" }, 404);
	}

	const ip = await hashIp(
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	const existing = await identityExists("applies", themeId, device, ip, env);
	if (!existing) {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO applies (theme_id, device, ip, created) VALUES (?, ?, ?, ?)",
			).bind(themeId, device, ip, Date.now()),
			env.DB.prepare(
				"INSERT INTO theme_counts (theme_id, votes, applies) VALUES (?, 0, 1) " +
					"ON CONFLICT(theme_id) DO UPDATE SET applies = applies + 1",
			).bind(themeId),
		]);
		purgeCounts(request, ctx);
	}

	const count = await env.DB.prepare(
		"SELECT applies AS c FROM theme_counts WHERE theme_id = ?",
	)
		.bind(themeId)
		.first();

	return json({ downloads: count?.c ?? 0 });
}

async function counts(request, env, ctx) {
	const cache = caches.default;
	const key = countsCacheKey(request);
	const hit = await cache.match(key);
	if (hit) return hit;

	const rows = await env.DB.prepare(
		"SELECT theme_id, votes, applies FROM theme_counts",
	).all();

	const out = { upvotes: {}, downloads: {} };
	for (const row of rows.results ?? []) {
		if (row.votes > 0) out.upvotes[row.theme_id] = row.votes;
		if (row.applies > 0) out.downloads[row.theme_id] = row.applies;
	}

	const response = json(out);
	response.headers.set(
		"cache-control",
		`public, s-maxage=${COUNTS_CACHE_SECONDS}`,
	);
	ctx.waitUntil(cache.put(key, response.clone()));
	return response;
}

function countsCacheKey(request) {
	const url = new URL(request.url);
	url.pathname = "/counts";
	url.search = "";
	return new Request(url.toString(), { method: "GET" });
}

function purgeCounts(request, ctx) {
	ctx?.waitUntil(caches.default.delete(countsCacheKey(request)));
}

async function identityExists(table, themeId, device, ip, env) {
	const byDevice = await env.DB.prepare(
		`SELECT 1 FROM ${table} WHERE theme_id = ? AND device = ?`,
	)
		.bind(themeId, device)
		.first();
	if (byDevice) return true;

	const byIp = await env.DB.prepare(
		`SELECT 1 FROM ${table} WHERE theme_id = ? AND ip = ?`,
	)
		.bind(themeId, ip)
		.first();
	return Boolean(byIp);
}

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

	await env.DB.prepare("DELETE FROM uploads WHERE created < ?")
		.bind(dayAgo)
		.run();

	return json({ queued: true });
}

const MAX_ADMIN_FAILURES_PER_HOUR = 5;
const GITHUB_MAX_RETRIES = 3;
const GITHUB_MAX_BACKOFF_MS = 10000;

async function hashIp(ip) {
	const data = new TextEncoder().encode(`${ip}colorblendr-ip-v1`);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function adminKeyMatches(candidate, secret) {
	if (!candidate || !secret) return false;
	const enc = new TextEncoder();
	const a = enc.encode(candidate);
	const b = enc.encode(secret);
	if (a.byteLength !== b.byteLength) return false;
	return crypto.subtle.timingSafeEqual(a, b);
}

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

async function openPullRequest(env, id, themeName, themeJson) {
	const gh = (path, init) => githubFetch(env, path, init);
	const branch = `theme/${id}`;
	const path = `themes/${id}.json`;
	const owner = env.GITHUB_REPO.split("/")[0];

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
	if (!created.ok && created.status !== 422) return null;

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
