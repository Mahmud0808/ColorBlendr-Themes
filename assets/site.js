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

// ---- Site-wide dynamic coloring -------------------------------------------

function applySiteSeed(seedHex, style, spec, sliders) {
	const { accentSat = 100, bgSat = 100, bgLight = 100 } = sliders ?? {};
	const Ctor = SCHEME_BY_STYLE[style] ?? SchemeTonalSpot;
	const scheme = new Ctor(
		Hct.fromInt(argbFromHex(seedHex)),
		true,
		0,
		spec ?? DEFAULT_SPEC,
	);
	const role = (argb) => hexFromArgb(argb);
	const accent = (argb) => adjustSaturation(role(argb), accentSat);
	// Tone floors keep slider-shifted surfaces off pure black + separated.
	const surf = (argb, minTone, maxTone) =>
		shiftLightness(adjustSaturation(role(argb), bgSat), bgLight, minTone, maxTone);

	const vars = {
		"--bg": surf(scheme.surface, 4, 99),
		"--text": role(scheme.onSurface),
		"--subtle": alpha(role(scheme.onSurfaceVariant), 0.75),
		"--body2": role(scheme.onSurfaceVariant),
		"--accent": accent(scheme.primary),
		"--on-accent": role(scheme.onPrimary),
		"--accent-glow": alpha(accent(scheme.primary), 0.32),
		"--tonal": role(scheme.secondaryContainer),
		"--on-tonal": role(scheme.onSecondaryContainer),
		"--card": surf(scheme.surfaceContainer, 10, 96),
		"--card-high": surf(scheme.surfaceContainerHigh, 14, 93),
		"--card-highest": surf(scheme.surfaceContainerHighest, 16, 91),
		"--outline-v": role(scheme.outlineVariant),
		"--grad-a": role(scheme.onSurface),
		"--grad-b": accent(scheme.primary),
		"--grad-c": accent(scheme.tertiary),
	};
	for (const [k, v] of Object.entries(vars)) {
		document.documentElement.style.setProperty(k, v);
	}

	// Hero logo disc follows the seed (launcher gradient formula).
	const stops = document.querySelectorAll("#lg stop");
	if (stops.length === 2) {
		stops[0].style.setProperty(
			"stop-color",
			adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(70)), accentSat),
		);
		stops[1].style.setProperty(
			"stop-color",
			adjustSaturation(hexFromArgb(scheme.primaryPalette.tone(40)), accentSat),
		);
	}
}

// Boot color; matches the :root CSS fallbacks so first paint = first seed.
const INITIAL_SEED = "#51BDFF";

// Seed the site rests on when no card is hovered; rotation moves it.
let restingSeed = INITIAL_SEED;
let hoverHold = false;

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
	let i = 0;
	setInterval(() => {
		if (hoverHold) return;
		i = (i + 1) % seeds.length;
		restingSeed = seeds[i];
		applySiteSeed(restingSeed);
	}, 7000);
}

// Hovered card retints the whole site with its seed; leave reverts.
// --recolor shortens every themed transition while the hover drives it.
function initHoverTheming(container) {
	if (!container || !matchMedia("(hover: hover)").matches) return;
	const root = document.documentElement;
	let activeSeed = null;
	let clearTimer = null;
	container.addEventListener("mouseover", (e) => {
		const card = e.target.closest?.(".tcard");
		const seed = card?.dataset.seed;
		if (!seed || seed === activeSeed) return;
		activeSeed = seed;
		hoverHold = true;
		if (clearTimer) clearTimeout(clearTimer);
		root.style.setProperty("--recolor", ".5s");
		applySiteSeed(seed, card.dataset.style, card.dataset.spec, {
			accentSat: +card.dataset.asat || 100,
			bgSat: +card.dataset.bsat || 100,
			bgLight: +card.dataset.blight || 100,
		});
	});
	container.addEventListener("mouseout", (e) => {
		const card = e.target.closest?.(".tcard");
		if (!card || card.contains(e.relatedTarget)) return;
		if (e.relatedTarget?.closest?.(".tcard")) return;
		activeSeed = null;
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
	const scheme = new Ctor(Hct.fromInt(argbFromHex(seed)), true, 0, spec);
	const isMono = theme.style === "MONOCHROMATIC";
	const accentSat = isMono ? 100 : (theme.accentSaturation ?? 100);
	const bgSat = isMono ? 100 : (theme.backgroundSaturation ?? 100);
	const bgLight = isMono ? 100 : (theme.backgroundLightness ?? 100);

	const customPalette = (hex) =>
		HEX.test(hex ?? "")
			? new Ctor(Hct.fromInt(argbFromHex(hex)), true, 0, spec).primaryPalette
			: null;
	const secondaryPalette =
		customPalette(theme.secondaryColor) ?? scheme.secondaryPalette;
	const tertiaryPalette =
		customPalette(theme.tertiaryColor) ?? scheme.tertiaryPalette;

	const cell = (palette, overrideKey, tone, accent) => {
		const override = theme.colorOverrides?.[overrideKey];
		if (override && HEX.test(override)) return override;
		const base = hexFromArgb(palette.tone(tone));
		return accent
			? adjustSaturation(base, accentSat)
			: shiftLightness(adjustSaturation(base, bgSat), bgLight);
	};

	return {
		spec,
		accentSat,
		bgSat,
		bgLight,
		halfCircle: cell(scheme.primaryPalette, "system_accent1_200", 80, true),
		firstQuarter: cell(tertiaryPalette, "system_accent3_300", 70, true),
		secondQuarter: cell(secondaryPalette, "system_accent2_400", 60, true),
		square: cell(
			scheme.neutralVariantPalette,
			"system_neutral2_700",
			30,
			false,
		),
		center: seed,
		container: shiftLightness(
			adjustSaturation(hexFromArgb(scheme.surfaceContainerHigh), bgSat),
			bgLight,
		),
		text: hexFromArgb(scheme.onSurface),
		subtle: hexFromArgb(scheme.onSurfaceVariant),
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
	return `<a class="tcard" data-seed="${seed}" data-style="${esc(theme.style ?? "")}" data-spec="${c.spec}" data-asat="${c.accentSat}" data-bsat="${c.bgSat}" data-blight="${c.bgLight}" style="background:${c.container};color:${c.text}" href="${WORKER}/theme/${esc(theme.id)}">
        ${swatchSvg(c)}
        <span class="tinfo">
            <span class="tname">${esc(theme.name)}</span>
            <span class="tauthor" style="color:${c.subtle}">by ${esc(theme.author || "Anonymous")}</span>
            <span class="tstats" style="color:${c.subtle}">
                <span>${thumbIcon}${theme.upvotes ?? 0}</span>
                <span>${downloadIcon}${theme.downloads ?? 0}</span>
            </span>
        </span>
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
	applySiteSeed(INITIAL_SEED);
	initReveal();
	initFaq();
	try {
		const themes = await loadThemes();
		startSeedRotation(themes);
		const top = [...themes].sort(SORTS.trending).slice(0, 10);
		const set = top.map(cardHtml).join("");
		const setReversed = [...top].reverse().map(cardHtml).join("");
		// Loop = two identical halves shifted -50%; each half must cover the
		// viewport or blank space drifts in before the wrap. Rebuilt when the
		// viewport outgrows the built halves (maximize, zoom out).
		const setWidth = top.length * 296;
		let builtPerHalf = 0;
		const buildRail = () => {
			const perHalf = Math.max(
				1,
				Math.ceil(window.innerWidth / setWidth),
			);
			if (perHalf <= builtPerHalf) return;
			builtPerHalf = perHalf;
			const half = set.repeat(perHalf);
			const halfReversed = setReversed.repeat(perHalf);
			// Second row: mobile only, reversed list, opposite drift.
			document.getElementById("rail").innerHTML =
				`<div class="marquee-track">${half}${half}</div>` +
				`<div class="marquee-track track2">${halfReversed}${halfReversed}</div>`;
		};
		buildRail();
		window.addEventListener("resize", buildRail);
		initHoverTheming(document.getElementById("rail"));
	} catch {
		document.getElementById("rail").innerHTML =
			'<div class="loading">Could not load themes right now.</div>';
	}
}

export async function initAllThemes() {
	applySiteSeed(INITIAL_SEED);
	initReveal();
	initHoverTheming(document.getElementById("grid"));
	let themes = [];
	try {
		themes = await loadThemes();
		startSeedRotation(themes);
	} catch {
		document.getElementById("grid").innerHTML =
			'<div class="loading">Could not load themes right now.</div>';
		return;
	}

	const search = document.getElementById("search");
	let sortValue = "trending";
	const render = () => {
		const query = search.value.trim().toLowerCase();
		const list = themes
			.filter(
				(t) =>
					!query ||
					(t.name ?? "").toLowerCase().includes(query) ||
					(t.author ?? "").toLowerCase().includes(query),
			)
			.sort(SORTS[sortValue] ?? SORTS.trending);
		document.getElementById("grid").innerHTML = list.length
			? list.map(cardHtml).join("")
			: '<div class="loading">No themes match.</div>';
	};
	search.addEventListener("input", render);

	// Custom sort menu: native select popups ignore theming.
	const menuwrap = document.querySelector(".menuwrap");
	const sortBtn = document.getElementById("sortBtn");
	const sortMenu = document.getElementById("sortMenu");
	const sortLabel = document.getElementById("sortLabel");
	const items = [...sortMenu.querySelectorAll(".menuitem")];
	const syncSelected = () =>
		items.forEach((item) =>
			item.classList.toggle("selected", item.dataset.value === sortValue),
		);
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
