// Shared site logic: MCU-derived dynamic coloring (rotating seed), app-style
// theme card swatches, marquee + grid rendering.
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
} from "https://esm.run/@material/material-color-utilities@0.4.0";

const WORKER = "https://colorblendr-themes.drdisagree.workers.dev";
const HEX = /^#[0-9a-fA-F]{6}$/;

// App enum ordinal -> MCU spec. JS lib has no 2026 yet; nearest is 2025.
const SPEC_BY_VERSION = { 0: "2021", 1: "2025", 2: "2025" };
const DEFAULT_SPEC = "2025";

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

// Counts of 1000+ collapse to 1K / 1.1K so a popular theme's stats stay inside
// the card. Truncated, never rounded up, so the shown figure is never ahead of
// the real one.
const compact = (n) => {
	const value = Number(n) || 0;
	if (value < 1000) return String(value);
	const [unit, divisor] = value < 1e6 ? ["K", 1e3] : ["M", 1e6];
	const scaled = Math.floor((value / divisor) * 10) / 10;
	return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${unit}`;
};
const alpha = (hex, a) =>
	hex +
	Math.round(a * 255)
		.toString(16)
		.padStart(2, "0");

// App CAM16 slider math ports (ColorUtil.adjustSaturation / shiftLightness).
function adjustSaturation(hex, saturation) {
	if (saturation === 100) return hex;
	const satF = (saturation - 100) / 100;
	const hct = Hct.fromInt(argbFromHex(hex));
	const target = Hct.from(hct.hue, 200, hct.tone);
	let chroma = hct.chroma;
	chroma += satF > 0 ? (target.chroma - chroma) * satF : chroma * satF;
	return hexFromArgb(Hct.from(hct.hue, chroma, hct.tone).toInt());
}

function shiftLightness(hex, lightness, minTone = 0, maxTone = 100) {
	const hct = Hct.fromInt(argbFromHex(hex));
	const tone = Math.max(
		minTone,
		Math.min(maxTone, hct.tone + (lightness - 100) / 10),
	);
	if (tone === hct.tone) return hex;
	return hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
}

// ---- Shade overrides --------------------------------------------------------

// colorOverrides keys are Android palette resources, system_<row>_<step>.
// Steps are fixed tonal stops; MCU roles land between them (dark surface is
// tone 6, surfaceContainer 12), so overrides act as hue/chroma anchors and
// the role keeps its own tone. Exact stops are used verbatim.
const STEP_TONE = {
	0: 100,
	10: 99,
	50: 95,
	100: 90,
	200: 80,
	300: 70,
	400: 60,
	500: 50,
	600: 40,
	700: 30,
	800: 20,
	900: 10,
	1000: 0,
};

const ROW_PALETTE = {
	system_accent1: "primaryPalette",
	system_accent2: "secondaryPalette",
	system_accent3: "tertiaryPalette",
	system_neutral1: "neutralPalette",
	system_neutral2: "neutralVariantPalette",
};

// MCU role -> the Android palette row the app draws it from.
const ROLE_ROW = {
	surface: "system_neutral1",
	surfaceContainer: "system_neutral1",
	surfaceContainerHigh: "system_neutral1",
	surfaceContainerHighest: "system_neutral1",
	onSurface: "system_neutral1",
	onSurfaceVariant: "system_neutral2",
	outlineVariant: "system_neutral2",
	primary: "system_accent1",
	onPrimary: "system_accent1",
	secondaryContainer: "system_accent2",
	onSecondaryContainer: "system_accent2",
	tertiary: "system_accent3",
};

function anchorsByRow(overrides) {
	const rows = {};
	for (const [key, hex] of Object.entries(overrides ?? {})) {
		if (!HEX.test(hex)) continue;
		const cut = key.lastIndexOf("_");
		const row = key.slice(0, cut);
		const tone = STEP_TONE[key.slice(cut + 1)];
		// system_error has no palette on the site; skip it.
		if (tone == null || !ROW_PALETTE[row]) continue;
		(rows[row] ??= []).push({ tone, hex });
	}
	for (const list of Object.values(rows)) list.sort((a, b) => a.tone - b.tone);
	return rows;
}

// Hue/chroma interpolated between the surrounding anchors, tone untouched so
// role contrast survives. Past the last anchor the nearest one is extended.
// `snap` takes an anchor verbatim when the wanted tone is that close to it,
// so a role sitting near an Android step shows the theme's literal hex.
function toneFromAnchors(anchors, tone, snap = 0) {
	let lo = null;
	let hi = null;
	for (const a of anchors) {
		if (a.tone <= tone) lo = a;
		if (a.tone >= tone && !hi) hi = a;
	}
	if (lo?.tone === tone) return lo.hex;
	if (snap) {
		const near = [lo, hi]
			.filter(Boolean)
			.sort((a, b) => Math.abs(a.tone - tone) - Math.abs(b.tone - tone))[0];
		if (near && Math.abs(near.tone - tone) <= snap) return near.hex;
	}
	const hct = (a) => Hct.fromInt(argbFromHex(a.hex));
	if (!lo || !hi) {
		const edge = hct(lo ?? hi);
		return hexFromArgb(Hct.from(edge.hue, edge.chroma, tone).toInt());
	}
	const a = hct(lo);
	const b = hct(hi);
	const f = (tone - lo.tone) / (hi.tone - lo.tone);
	const dh = ((b.hue - a.hue + 540) % 360) - 180;
	return hexFromArgb(
		Hct.from(
			(a.hue + dh * f + 360) % 360,
			a.chroma + (b.chroma - a.chroma) * f,
			tone,
		).toInt(),
	);
}

// Resolves a palette shade to the theme's real color: overrides win, then a
// custom secondary/tertiary seed, then the scheme. `fixed` marks values that
// already carry the theme's own numbers, so the saturation and lightness
// sliders must not be applied to them a second time.
function makeResolver(scheme, theme, spec, Ctor) {
	const rows = anchorsByRow(theme?.colorOverrides);
	const customPalette = (hex) =>
		HEX.test(hex ?? "")
			? new Ctor(Hct.fromInt(argbFromHex(hex)), true, 0, spec)
					.primaryPalette
			: null;
	const swapped = {
		system_accent2: customPalette(theme?.secondaryColor),
		system_accent3: customPalette(theme?.tertiaryColor),
	};
	const shade = (row, tone, snap) => {
		if (rows[row]?.length) {
			return { hex: toneFromAnchors(rows[row], tone, snap), fixed: true };
		}
		const palette = swapped[row] ?? scheme[ROW_PALETTE[row]];
		return { hex: hexFromArgb(palette.tone(tone)), fixed: false };
	};
	// A role's tone comes from the scheme itself, so this tracks whichever
	// spec (2021/2025) built it instead of a hardcoded tone table. Accent
	// roles land within a few tones of an Android step, so they snap to the
	// theme's literal hex; neutrals must not, or the surface elevation tiers
	// (tone 4/9/12/15 in dark) would all collapse onto one override.
	const role = (name) => {
		const base = hexFromArgb(scheme[name]);
		const row = ROLE_ROW[name];
		if (!row) return { hex: base, fixed: false };
		const tone = Math.round(Hct.fromInt(argbFromHex(base)).tone);
		return shade(row, tone, row.startsWith("system_accent") ? 5 : 0);
	};
	return { shade, role };
}

// A flat override ramp can leave two elevation tiers on the same tone (Nova
// Ember pins neutral1 90 and 95 to near-identical grays), which reads as one
// sheet. Nudge each tier away from the one below it. dir: +1 dark, -1 light.
function separate(hex, belowHex, dir, min = 3) {
	const hct = Hct.fromInt(argbFromHex(hex));
	const below = Hct.fromInt(argbFromHex(belowHex)).tone;
	const need = below + dir * min;
	if (dir > 0 ? hct.tone >= need : hct.tone <= need) return hex;
	const tone = Math.max(0, Math.min(100, need));
	return hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
}

// Slider values for the active mode; the app ignores them for MONOCHROMATIC.
function themeSliders(theme) {
	if (!theme || theme.style === "MONOCHROMATIC") {
		return { accentSat: 100, bgSat: 100, bgLight: 100 };
	}
	const light = !isDark && theme.modeSpecificThemes;
	return {
		accentSat:
			(light ? theme.accentSaturationLight : theme.accentSaturation) ?? 100,
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

// ---- Color search -----------------------------------------------------------

// Same family = hue within a window; wider would cross into other colors.
const HUE_WINDOW = 30;
// Below this chroma hue is meaningless; treat as neutral (gray/black/white).
const NEUTRAL_CHROMA = 12;

function parseColorQuery(query) {
	const m = query.match(/^#?([0-9a-f]{6})$/i);
	return m ? "#" + m[1] : null;
}

function seedMatchesColor(seedHex, queryHex) {
	if (!HEX.test(seedHex ?? "")) return false;
	const seed = Hct.fromInt(argbFromHex(seedHex));
	const target = Hct.fromInt(argbFromHex(queryHex));
	if (target.chroma < NEUTRAL_CHROMA) return seed.chroma < NEUTRAL_CHROMA;
	if (seed.chroma < NEUTRAL_CHROMA) return false;
	const d = Math.abs(seed.hue - target.hue);
	return Math.min(d, 360 - d) <= HUE_WINDOW;
}

// ---- Site-wide dynamic coloring -------------------------------------------

// Site follows the OS light/dark preference; MCU derives both variants
// from the same seed. Mode flips re-render baked card HTML via handlers.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
let isDark = darkQuery.matches;
const modeHandlers = [];
darkQuery.addEventListener("change", (e) => {
	isDark = e.matches;
	persistTheme(applySiteSeed(restingSeed));
	for (const handler of modeHandlers) handler();
});

// `theme` is the full catalog entry when a card drives the tint; without it
// the site just renders the seed with library defaults (rotation, boot).
function applySiteSeed(seedHex, theme) {
	const Ctor = SCHEME_BY_STYLE[theme?.style] ?? SchemeTonalSpot;
	const spec = SPEC_BY_VERSION[theme?.colorSpecVersion] ?? DEFAULT_SPEC;
	const scheme = new Ctor(Hct.fromInt(argbFromHex(seedHex)), isDark, 0, spec);
	const { accentSat, bgSat, bgLight } = themeSliders(theme);
	const { shade, role } = makeResolver(scheme, theme, spec, Ctor);

	const plain = (name) => role(name).hex;
	const accent = (name) => {
		const r = role(name);
		return r.fixed ? r.hex : adjustSaturation(r.hex, accentSat);
	};
	// Tone floors keep slider-shifted surfaces off pure black + separated.
	// Overridden shades skip the sliders: the theme already baked them in.
	const surf = (name, minTone, maxTone) => {
		const r = role(name);
		return r.fixed
			? r.hex
			: shiftLightness(
					adjustSaturation(r.hex, bgSat),
					bgLight,
					minTone,
					maxTone,
				);
	};

	const dir = isDark ? 1 : -1;
	const bg = surf("surface", 4, 99);
	const card = separate(surf("surfaceContainer", 10, 96), bg, dir);
	const cardHigh = separate(surf("surfaceContainerHigh", 14, 93), card, dir);
	const cardHighest = separate(
		surf("surfaceContainerHighest", 16, 91),
		cardHigh,
		dir,
	);

	const vars = {
		"--bg": bg,
		"--text": plain("onSurface"),
		"--subtle": alpha(plain("onSurfaceVariant"), 0.75),
		"--body2": plain("onSurfaceVariant"),
		"--accent": accent("primary"),
		"--on-accent": plain("onPrimary"),
		"--accent-glow": alpha(accent("primary"), 0.32),
		"--tonal": plain("secondaryContainer"),
		"--on-tonal": plain("onSecondaryContainer"),
		"--card": card,
		"--card-high": cardHigh,
		"--card-highest": cardHighest,
		"--outline-v": plain("outlineVariant"),
		"--grad-a": plain("onSurface"),
		"--grad-b": accent("primary"),
		"--grad-c": accent("tertiary"),
	};
	for (const [k, v] of Object.entries(vars)) {
		document.documentElement.style.setProperty(k, v);
	}

	// Browser chrome follows the page surface.
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", vars["--bg"]);

	// Hero logo disc follows the seed (launcher gradient formula).
	const stopColors = [70, 40].map((tone) => {
		const s = shade("system_accent1", tone);
		return s.fixed ? s.hex : adjustSaturation(s.hex, accentSat);
	});
	const stops = document.querySelectorAll("#lg stop");
	if (stops.length === 2) {
		stops[0].style.setProperty("stop-color", stopColors[0]);
		stops[1].style.setProperty("stop-color", stopColors[1]);
	}
	return { vars, stops: stopColors };
}

// Boot color; matches the :root CSS fallbacks so first paint = first seed.
const INITIAL_SEED = "#51BDFF";

// Seed the site rests on when no card is hovered; rotation moves it.
// Persisted per tab with its computed palette; an inline head script on
// each page restores the vars pre-paint so navigation keeps the color.
const savedTheme = (() => {
	try {
		return JSON.parse(sessionStorage.getItem("siteTheme"));
	} catch {
		return null;
	}
})();
let restingSeed = savedTheme?.seed || INITIAL_SEED;
let hoverHold = false;

function persistTheme(applied) {
	sessionStorage.setItem(
		"siteTheme",
		JSON.stringify({ seed: restingSeed, dark: isDark, ...applied }),
	);
}

// Hue spread so the rotation tours the full wheel instead of hovering
// around whatever hues the catalog happens to contain.
const EXTRA_SEEDS = [
	"#F44336",
	"#FF7043",
	"#FFB300",
	"#C0CA33",
	"#4CAF50",
	"#26A69A",
	"#00BCD4",
	"#3F51B5",
	"#7C4DFF",
	"#AB47BC",
	"#EC407A",
	"#8D6E63",
];

// Catalog seeds interleaved with the spread; CSS transitions animate it.
function startSeedRotation(themes) {
	const catalog = themes
		.map((t) => t.seedColor)
		.filter((c) => HEX.test(c ?? ""));
	const merged = [];
	const max = Math.max(catalog.length, EXTRA_SEEDS.length);
	for (let k = 0; k < max; k++) {
		if (k < catalog.length) merged.push(catalog[k]);
		if (k < EXTRA_SEEDS.length) merged.push(EXTRA_SEEDS[k]);
	}
	const seeds = [...new Set([INITIAL_SEED, ...merged])];
	if (seeds.length < 2) return;
	let i = Math.max(0, seeds.indexOf(restingSeed));
	setInterval(() => {
		if (hoverHold) return;
		i = (i + 1) % seeds.length;
		restingSeed = seeds[i];
		persistTheme(applySiteSeed(restingSeed));
	}, 7000);
}

// Hovered card retints the whole site with its seed; leave reverts.
// --recolor shortens every themed transition while the hover drives it.
function initHoverTheming(container, byId) {
	if (!container || !matchMedia("(hover: hover)").matches) return;
	const root = document.documentElement;
	let activeId = null;
	let clearTimer = null;
	container.addEventListener("mouseover", (e) => {
		const card = e.target.closest?.(".tcard");
		const seed = card?.dataset.seed;
		const id = card?.dataset.id;
		if (!seed || id === activeId) return;
		activeId = id;
		hoverHold = true;
		if (clearTimer) clearTimeout(clearTimer);
		root.style.setProperty("--recolor", ".5s");
		applySiteSeed(seed, byId.get(id));
	});
	container.addEventListener("mouseout", (e) => {
		const card = e.target.closest?.(".tcard");
		if (!card || card.contains(e.relatedTarget)) return;
		if (e.relatedTarget?.closest?.(".tcard")) return;
		activeId = null;
		hoverHold = false;
		applySiteSeed(restingSeed);
		clearTimer = setTimeout(
			() => root.style.removeProperty("--recolor"),
			600,
		);
	});
}

// ---- Theme cards ------------------------------------------------------------

// App ColorsScreen swatch: square = neutral2 tone30, top half = accent1
// tone80, bottom-left = accent3 tone70, bottom-right = accent2 tone60,
// center dot = seed. Overrides + sliders honored per cell.
function cardData(theme) {
	const seed = HEX.test(theme.seedColor ?? "") ? theme.seedColor : "#6750A4";
	const Ctor = SCHEME_BY_STYLE[theme.style] ?? SchemeTonalSpot;
	const spec = SPEC_BY_VERSION[theme.colorSpecVersion] ?? DEFAULT_SPEC;
	const scheme = new Ctor(Hct.fromInt(argbFromHex(seed)), isDark, 0, spec);
	const { accentSat, bgSat, bgLight } = themeSliders(theme);
	const { shade, role } = makeResolver(scheme, theme, spec, Ctor);

	const accentCell = (row, tone) => {
		const s = shade(row, tone);
		return s.fixed ? s.hex : adjustSaturation(s.hex, accentSat);
	};
	const surfCell = (s) =>
		s.fixed
			? s.hex
			: shiftLightness(adjustSaturation(s.hex, bgSat), bgLight);

	return {
		halfCircle: accentCell("system_accent1", 80),
		firstQuarter: accentCell("system_accent3", 70),
		secondQuarter: accentCell("system_accent2", 60),
		square: surfCell(shade("system_neutral2", 30)),
		center: seed,
		// Primary tonal run for the hover strip along the card's bottom edge.
		strip: [95, 85, 70, 55, 40, 25].map((tone) =>
			accentCell("system_accent1", tone),
		),
		container: surfCell(role("surfaceContainerHigh")),
		text: role("onSurface").hex,
		subtle: role("onSurfaceVariant").hex,
	};
}

// SVG twin of WallColorPreviewCanvas (64 box, pad 8, corner 16, dot r13).
function swatchSvg(c) {
	return `<svg class="tswatch" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill="${c.square}"/>
        <path d="M8 32 A24 24 0 0 1 56 32 Z" fill="${c.halfCircle}"/>
        <path d="M32 32 L32 56 A24 24 0 0 1 8 32 Z" fill="${c.firstQuarter}"/>
        <path d="M32 32 L56 32 A24 24 0 0 1 32 56 Z" fill="${c.secondQuarter}"/>
        <circle cx="32" cy="32" r="13" fill="${c.center}"/>
    </svg>`;
}

const thumbIcon =
	'<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M13.12 2.06 7.58 7.6c-.37.37-.58.88-.58 1.41V19c0 1.1.9 2 2 2h9c.8 0 1.52-.48 1.84-1.21l3.26-7.61C23.94 10.2 22.49 8 20.34 8h-5.65l.95-4.58c.1-.5-.05-1.01-.41-1.37-.59-.58-1.53-.58-2.11.01ZM3 21c1.1 0 2-.9 2-2v-8c0-1.1-.9-2-2-2s-2 .9-2 2v8c0 1.1.9 2 2 2Z"/></svg>';
const downloadIcon =
	'<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71ZM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1Z"/></svg>';

function cardHtml(theme) {
	const c = cardData(theme);
	const seed = HEX.test(theme.seedColor ?? "") ? theme.seedColor : "";
	// Hover theming looks the entry up by id; colorOverrides are far too big
	// to bake into a data attribute on every (repeated) card.
	return `<a class="tcard" data-seed="${seed}" data-id="${esc(theme.id)}" style="background:${c.container};color:${c.text}" href="${WORKER}/theme/${esc(theme.id)}">
        ${swatchSvg(c)}
        <span class="tinfo">
            <span class="tname">${esc(theme.name)}</span>
            <span class="tauthor" style="color:${c.subtle}">by ${esc(theme.author || "Anonymous")}</span>
            <span class="tstats" style="color:${c.subtle}">
                <span>${thumbIcon}${compact(theme.upvotes)}</span>
                <span>${downloadIcon}${compact(theme.downloads)}</span>
            </span>
        </span>
        <span class="pstrip" aria-hidden="true">${c.strip.map((hex) => `<i style="background:${hex}"></i>`).join("")}</span>
    </a>`;
}

// ---- Data + sorting ----------------------------------------------------------

const trendingScore = (t) => {
	const days = Math.max(0, Date.now() / 1000 - (t.createdAt ?? 0)) / 86400;
	return (
		((t.upvotes ?? 0) + (t.downloads ?? 0) * 0.5) / Math.pow(days + 2, 1.5)
	);
};

const SORTS = {
	trending: (a, b) => trendingScore(b) - trendingScore(a),
	upvotes: (a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0),
	downloads: (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
	latest: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
};

async function loadThemes() {
	const base = location.pathname.replace(/[^/]*$/, "");
	const response = await fetch(`${base}index.json`);
	return response.json();
}

// Cursor spotlight on cards: one delegated listener feeds --mx/--my to the
// hovered element's ::after radial gradient.
function initSpotlight() {
	if (!matchMedia("(hover: hover)").matches) return;
	document.addEventListener(
		"pointermove",
		(e) => {
			const el = e.target.closest?.(".tcard, .info");
			if (!el) return;
			const rect = el.getBoundingClientRect();
			el.style.setProperty("--mx", e.clientX - rect.left + "px");
			el.style.setProperty("--my", e.clientY - rect.top + "px");
		},
		{ passive: true },
	);
}

// Count-up numbers when they scroll into view.
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

function animateCount(el) {
	const target = +el.dataset.count || 0;
	if (REDUCED_MOTION.matches) {
		el.textContent = target;
		return;
	}
	const start = performance.now();
	const duration = 900;
	const tick = (now) => {
		const p = Math.min(1, (now - start) / duration);
		el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
		if (p < 1) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

function initCountUps(scope) {
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				animateCount(entry.target);
			}
		},
		{ threshold: 0.5 },
	);
	scope
		.querySelectorAll("[data-count]")
		.forEach((el) => observer.observe(el));
}

// Scroll-in reveal for sections below the fold.
function initReveal() {
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					entry.target.classList.add("in");
					observer.unobserve(entry.target);
				}
			}
		},
		{ threshold: 0.12 },
	);
	document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
}

// Animated expand/collapse for FAQ details (native toggle snaps).
function initFaq() {
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	document.querySelectorAll(".faq details").forEach((detail) => {
		const summary = detail.querySelector("summary");
		const answer = detail.querySelector(".answer");
		let animation = null;

		summary.addEventListener("click", (e) => {
			e.preventDefault();
			if (reduced) {
				detail.open = !detail.open;
				return;
			}
			animation?.cancel();
			if (detail.open) {
				// fill: forwards holds height at 0 until [open] drops,
				// otherwise the last frame snaps back to full height.
				// Padding animated too: border-box height 0 still renders
				// the bottom padding, which snapped on [open] removal.
				animation = answer.animate(
					[
						{
							height: answer.offsetHeight + "px",
							paddingBottom: "20px",
							opacity: 1,
						},
						{ height: "0px", paddingBottom: "0px", opacity: 0 },
					],
					{
						duration: 250,
						easing: "cubic-bezier(.2,.7,.2,1)",
						fill: "forwards",
					},
				);
				animation.onfinish = () => {
					detail.open = false;
					animation.cancel();
					animation = null;
				};
			} else {
				detail.open = true;
				animation = answer.animate(
					[
						{ height: "0px", paddingBottom: "0px", opacity: 0 },
						{
							height: answer.scrollHeight + "px",
							paddingBottom: "20px",
							opacity: 1,
						},
					],
					{ duration: 300, easing: "cubic-bezier(.2,.7,.2,1)" },
				);
				animation.onfinish = () => {
					animation = null;
				};
			}
		});
	});
}

// ---- Page entry points -------------------------------------------------------

export async function initHome() {
	persistTheme(applySiteSeed(restingSeed));
	initReveal();
	initFaq();
	initSpotlight();
	try {
		const themes = await loadThemes();
		startSeedRotation(themes);
		const top = [...themes].sort(SORTS.trending).slice(0, 10);
		// Loop = two identical halves shifted -50%; each half must cover the
		// viewport or blank space drifts in before the wrap. Rebuilt when the
		// viewport outgrows the built halves (maximize, zoom out) and when the
		// light/dark mode flips (card colors are baked into the HTML).
		const setWidth = top.length * 296;
		let builtPerHalf = 0;
		const buildRail = (force) => {
			if (force) builtPerHalf = 0;
			const perHalf = Math.max(
				1,
				Math.ceil(window.innerWidth / setWidth),
			);
			if (perHalf <= builtPerHalf) return;
			builtPerHalf = perHalf;
			const set = top.map((t) => cardHtml(t)).join("");
			const setReversed = [...top]
				.reverse()
				.map((t) => cardHtml(t))
				.join("");
			const half = set.repeat(perHalf);
			const halfReversed = setReversed.repeat(perHalf);
			// Second row: mobile only, reversed list, opposite drift.
			document.getElementById("rail").innerHTML =
				`<div class="marquee-track">${half}${half}</div>` +
				`<div class="marquee-track track2">${halfReversed}${halfReversed}</div>`;
		};
		buildRail();
		window.addEventListener("resize", () => buildRail());
		modeHandlers.push(() => buildRail(true));
		initHoverTheming(
			document.getElementById("rail"),
			new Map(themes.map((t) => [t.id, t])),
		);

		// Catalog totals under the rail, counting up on reveal.
		const stats = document.getElementById("stats");
		if (stats) {
			const sum = (key) =>
				themes.reduce((acc, t) => acc + (t[key] ?? 0), 0);
			const values = [themes.length, sum("upvotes"), sum("downloads")];
			stats.querySelectorAll(".statnum").forEach((el, i) => {
				el.dataset.count = values[i];
			});
			stats.hidden = false;
			initCountUps(stats);
		}
	} catch {
		document.getElementById("rail").innerHTML =
			'<div class="loading" role="status">Couldn\'t load creations. Check your connection, then reload the page.</div>';
	}
}

export async function initAllThemes() {
	persistTheme(applySiteSeed(restingSeed));
	initReveal();
	initSpotlight();
	let themes = [];
	try {
		themes = await loadThemes();
		startSeedRotation(themes);
		initHoverTheming(
			document.getElementById("grid"),
			new Map(themes.map((t) => [t.id, t])),
		);
	} catch {
		document.getElementById("grid").innerHTML =
			'<div class="loading" role="status">Couldn\'t load creations. Check your connection, then reload the page.</div>';
		return;
	}

	const search = document.getElementById("search");
	let sortValue = "trending";
	const render = () => {
		const query = search.value.trim().toLowerCase();
		const colorQuery = parseColorQuery(query);
		const list = themes
			.filter(
				(t) =>
					!query ||
					(colorQuery !== null
						? seedMatchesColor(t.seedColor, colorQuery)
						: (t.name ?? "").toLowerCase().includes(query) ||
							(t.author ?? "").toLowerCase().includes(query)),
			)
			.sort(SORTS[sortValue] ?? SORTS.trending);
		const grid = document.getElementById("grid");
		grid.innerHTML = list.length
			? list.map((t) => cardHtml(t)).join("")
			: '<div class="loading">No creations match that search. Try another name, author, or color.</div>';
		// Grid itself is too noisy to make live; announce the count instead.
		const status = document.getElementById("gridStatus");
		if (status) {
			status.textContent = list.length
				? `${list.length} creation${list.length === 1 ? "" : "s"} shown.`
				: "No creations match that search.";
		}
	};
	search.addEventListener("input", render);
	modeHandlers.push(render);

	// Themed hue wheel popover fills the search box with a hex; render()
	// detects it. Native color dialog can't be styled.
	const colorBtn = document.getElementById("searchColorBtn");
	const colorPop = document.getElementById("colorPop");
	const hueWrap = colorPop?.querySelector(".huewrap");
	const hueWheel = document.getElementById("hueWheel");
	const hueThumb = document.getElementById("hueThumb");
	const huePrevDot = document.getElementById("huePrevDot");
	const huePrevHex = document.getElementById("huePrevHex");
	const hueNeutral = document.getElementById("hueNeutral");
	if (colorBtn && colorPop) {
		let hue = 205;
		// HSL hue -> hex so the thumb position matches the wheel color.
		const hueToHex = (h) => {
			const f = (n) => {
				const k = (n + h / 30) % 12;
				const c =
					0.525 - 0.425 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
				return Math.round(c * 255)
					.toString(16)
					.padStart(2, "0");
			};
			return ("#" + f(0) + f(8) + f(4)).toUpperCase();
		};
		const positionThumb = () => {
			// Ring midline; hue 0 at 12 o'clock, clockwise like the gradient.
			const rad = (hue * Math.PI) / 180;
			const r = 42; // % of wrap size
			hueThumb.style.left = 50 + r * Math.sin(rad) + "%";
			hueThumb.style.top = 50 - r * Math.cos(rad) + "%";
			hueThumb.style.background = hueToHex(hue);
			hueWheel.setAttribute("aria-valuenow", String(Math.round(hue)));
		};
		const applyHue = () => {
			positionThumb();
			const hex = hueToHex(hue);
			huePrevDot.style.background = hex;
			huePrevHex.textContent = hex;
			search.value = hex;
			render();
		};
		const setPopOpen = (open) => {
			colorPop.hidden = !open;
			colorBtn.setAttribute("aria-expanded", String(open));
		};
		const setFromPointer = (e) => {
			const rect = hueWrap.getBoundingClientRect();
			const dx = e.clientX - (rect.left + rect.width / 2);
			const dy = e.clientY - (rect.top + rect.height / 2);
			hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
			applyHue();
		};
		hueWrap.addEventListener("pointerdown", (e) => {
			hueWrap.setPointerCapture(e.pointerId);
			setFromPointer(e);
		});
		hueWrap.addEventListener("pointermove", (e) => {
			if (e.buttons) setFromPointer(e);
		});
		hueWheel.addEventListener("keydown", (e) => {
			const step = {
				ArrowRight: 4,
				ArrowUp: 4,
				ArrowLeft: -4,
				ArrowDown: -4,
			}[e.key];
			if (!step) return;
			e.preventDefault();
			hue = (hue + step + 360) % 360;
			applyHue();
		});
		colorBtn.addEventListener("click", () => setPopOpen(colorPop.hidden));
		hueNeutral.addEventListener("click", () => {
			huePrevDot.style.background = "#808080";
			huePrevHex.textContent = "Neutrals";
			search.value = "#808080";
			setPopOpen(false);
			render();
		});
		document.addEventListener("click", (e) => {
			if (!colorPop.contains(e.target) && !colorBtn.contains(e.target)) {
				setPopOpen(false);
			}
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") setPopOpen(false);
		});
		positionThumb();
	}

	// Custom sort menu: native select popups ignore theming.
	const menuwrap = document.querySelector(".menuwrap");
	const sortBtn = document.getElementById("sortBtn");
	const sortMenu = document.getElementById("sortMenu");
	const sortLabel = document.getElementById("sortLabel");
	const items = [...sortMenu.querySelectorAll(".menuitem")];
	const syncSelected = () =>
		items.forEach((item) => {
			const on = item.dataset.value === sortValue;
			item.classList.toggle("selected", on);
			item.setAttribute("aria-selected", String(on));
		});
	const setOpen = (open) => {
		sortMenu.hidden = !open;
		menuwrap.classList.toggle("open", open);
		sortBtn.setAttribute("aria-expanded", String(open));
	};
	syncSelected();
	sortBtn.addEventListener("click", () => setOpen(sortMenu.hidden));
	items.forEach((item) =>
		item.addEventListener("click", () => {
			sortValue = item.dataset.value;
			sortLabel.textContent = item.textContent;
			syncSelected();
			setOpen(false);
			render();
		}),
	);
	document.addEventListener("click", (e) => {
		if (!menuwrap.contains(e.target)) setOpen(false);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") setOpen(false);
	});

	render();
}
