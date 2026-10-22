// Port of the ColorBlendr app theme engine (app/.../theme): MCU schemes with
// custom secondary/tertiary palettes, palette tuning (saturation, lightness,
// accurate shades), gamut clipping, shade overrides blended in Lab, pitch
// black + tintless text rules and token overrides. Keep in sync with the app.

const SHADE_TONES = [100, 99, 95, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const SHADES = ["0", "10", "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"];
const ROLES = ["PRIMARY", "SECONDARY", "TERTIARY", "NEUTRAL", "NEUTRAL_VARIANT", "ERROR"];
const ROW_NAMES = [
	"system_accent1",
	"system_accent2",
	"system_accent3",
	"system_neutral1",
	"system_neutral2",
	"system_error",
];
const SHADE_900 = 11;
const NEUTRAL_LEVEL = 100;
const SPEC_BY_VERSION = { 0: "2021", 1: "2025", 2: "2026" };

const DARKEST_CURVE = [[0, 0], [6, 0], [12, 2], [90, 80], [100, 100]];
const BRIGHTEST_CURVE = [[0, 0], [10, 20], [88, 98], [100, 100]];
const VIVID_SHADES_FACTOR = 1.25;
const VIVID_TONE_SHIFT = 6;
const VIVID_TAPER_TONES = 10;
const MID_TONE = 50;

const CHROMA_EPSILON = 0.5;
const SEARCH_STEPS = 16;
const YELLOW_FIX_TONE = 99;
const ADAPTIVE_ALPHA = 1;

const PITCH_BLACK_SPREAD = 1.15;
const SURFACE_TOKENS = new Set([
	"background",
	"surface",
	"surfaceDim",
	"surfaceBright",
	"surfaceContainerLowest",
	"surfaceContainerLow",
	"surfaceContainer",
	"surfaceContainerHigh",
	"surfaceContainerHighest",
]);
const SURFACE_TEXT_TOKENS = new Set([
	"onSurface",
	"onSurfaceVariant",
	"onBackground",
	"onPrimaryContainer",
	"onSecondaryContainer",
	"onTertiaryContainer",
	"onErrorContainer",
]);

const SHADE_LINK = /^(system_(?:accent[123]|neutral[12]|error))_(\d+)(?:@([0-9A-Fa-f]{2}))?$/;
const CUSTOM_COLOR = /^#([0-9A-Fa-f]{8})$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

const isNeutral = (role) => role === "NEUTRAL" || role === "NEUTRAL_VARIANT";
const isAccent = (role) => role === "PRIMARY" || role === "SECONDARY" || role === "TERTIARY";
const resourceName = (token) => token.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createThemeEngine(mcu) {
	const {
		Hct,
		TonalPalette,
		DynamicScheme,
		MaterialDynamicColors,
		argbFromHex,
		hexFromArgb,
		labFromArgb,
		argbFromLab,
	} = mcu;

	const SCHEME_BY_STYLE = {
		SPRITZ: mcu.SchemeNeutral,
		MONOCHROMATIC: mcu.SchemeMonochrome,
		TONAL_SPOT: mcu.SchemeTonalSpot,
		VIBRANT: mcu.SchemeVibrant,
		RAINBOW: mcu.SchemeRainbow,
		EXPRESSIVE: mcu.SchemeExpressive,
		FIDELITY: mcu.SchemeFidelity,
		CONTENT: mcu.SchemeContent,
		FRUIT_SALAD: mcu.SchemeFruitSalad,
		CMF: mcu.SchemeCmf,
	};
	const colors = new MaterialDynamicColors();

	function createScheme(style, seedHex, isDark, specVersion) {
		const Ctor = SCHEME_BY_STYLE[style] ?? mcu.SchemeTonalSpot;
		const spec = style === "CMF" ? "2026" : SPEC_BY_VERSION[specVersion] ?? "2021";
		return new Ctor(Hct.fromInt(argbFromHex(seedHex)), isDark, 0, spec);
	}

	function schemeFor(theme, seedHex, isDark) {
		const base = createScheme(theme.style, seedHex, isDark, theme.colorSpecVersion);
		const accent = (hex) =>
			HEX.test(hex ?? "") ? createScheme(theme.style, hex, isDark, theme.colorSpecVersion).primaryPalette : null;
		const secondary = accent(theme.secondaryColor);
		const tertiary = accent(theme.tertiaryColor);
		if (!secondary && !tertiary) return base;
		return new DynamicScheme({
			sourceColorHct: base.sourceColorHct,
			variant: base.variant,
			isDark,
			contrastLevel: base.contrastLevel,
			platform: base.platform,
			specVersion: base.specVersion,
			primaryPalette: base.primaryPalette,
			secondaryPalette: secondary ?? base.secondaryPalette,
			tertiaryPalette: tertiary ?? base.tertiaryPalette,
			neutralPalette: base.neutralPalette,
			neutralVariantPalette: base.neutralVariantPalette,
			errorPalette: base.errorPalette,
		});
	}

	const paletteOf = (scheme, role) =>
		({
			PRIMARY: scheme.primaryPalette,
			SECONDARY: scheme.secondaryPalette,
			TERTIARY: scheme.tertiaryPalette,
			NEUTRAL: scheme.neutralPalette,
			NEUTRAL_VARIANT: scheme.neutralVariantPalette,
			ERROR: scheme.errorPalette,
		})[role];

	const roleOf = (scheme, palette) => ROLES.find((role) => paletteOf(scheme, role) === palette) ?? null;

	function tuning(role, style, sliders, accurateShades) {
		const mono = style === "MONOCHROMATIC";
		const saturation = mono
			? NEUTRAL_LEVEL
			: isNeutral(role) && style === "RAINBOW"
				? NEUTRAL_LEVEL
				: isNeutral(role)
					? sliders.bgSat
					: sliders.accentSat;
		const lightness = mono || isNeutral(role) ? sliders.bgLight : NEUTRAL_LEVEL;
		const vivid = !(accurateShades || mono || !isAccent(role));
		const chromaFactor = (saturation / NEUTRAL_LEVEL) * (vivid ? VIVID_SHADES_FACTOR : 1);
		const toneBlend = (NEUTRAL_LEVEL - lightness) / NEUTRAL_LEVEL;

		const curveMap = (curve, tone) => {
			let upper = curve.findIndex(([from]) => from >= tone);
			if (upper < 1) upper = 1;
			const [fromA, toA] = curve[upper - 1];
			const [fromB, toB] = curve[upper];
			return toA + ((toB - toA) * (tone - fromA)) / (fromB - fromA);
		};
		const lightnessTone = (tone) => {
			if (lightness === NEUTRAL_LEVEL) return tone;
			const t = clamp(tone, 0, 100);
			const curve = toneBlend > 0 ? DARKEST_CURVE : BRIGHTEST_CURVE;
			return t + Math.abs(toneBlend) * (curveMap(curve, t) - t);
		};
		const vividTone = (tone) => {
			if (tone <= MID_TONE) return tone;
			const fromWhite = clamp((100 - tone) / VIVID_TAPER_TONES, 0, 1);
			const fromMid = clamp((tone - MID_TONE) / VIVID_TAPER_TONES, 0, 1);
			return tone - VIVID_TONE_SHIFT * fromWhite * fromMid;
		};

		return {
			chromaFactor,
			identity: lightness === NEUTRAL_LEVEL && chromaFactor === 1 && !vivid,
			tone: (tone) => (vivid ? vividTone(lightnessTone(tone)) : lightnessTone(tone)),
		};
	}

	function preserveTone(hue, chroma, tone) {
		return tone === YELLOW_FIX_TONE && Hct.isYellow(hue)
			? TonalPalette.fromHueAndChroma(hue, chroma).tone(YELLOW_FIX_TONE)
			: Hct.from(hue, chroma, tone).toInt();
	}

	const fits = (hue, chroma, tone) => Hct.from(hue, chroma, tone).chroma >= chroma - CHROMA_EPSILON;

	function adaptiveMidTone(tone, chroma, alpha) {
		const offset = tone - 0.5;
		const e1 = 0.5 + Math.abs(offset) + alpha * chroma;
		return 0.5 * (1 + Math.sign(offset) * (e1 - Math.sqrt(e1 * e1 - 2 * Math.abs(offset))));
	}

	function adaptiveTowardsMid(hue, chroma, tone, alpha) {
		if (tone <= 0 || tone >= 100 || fits(hue, chroma, tone)) return preserveTone(hue, chroma, tone);
		const pivot = adaptiveMidTone(tone / 100, chroma / 100, alpha) * 100;
		const toneAt = (c) => pivot + ((tone - pivot) * c) / chroma;
		let low = 0;
		let high = chroma;
		for (let i = 0; i < SEARCH_STEPS; i++) {
			const mid = (low + high) / 2;
			if (fits(hue, mid, toneAt(mid))) low = mid;
			else high = mid;
		}
		return Hct.from(hue, low, toneAt(low)).toInt();
	}

	function scaled(hue, chroma, tone, factor) {
		const target = Hct.from(hue, chroma, tone).chroma * factor;
		return factor <= 1 ? preserveTone(hue, target, tone) : adaptiveTowardsMid(hue, target, tone, ADAPTIVE_ALPHA);
	}

	function adjustedPalette(palette, tune, overrides) {
		const tuned = (tone, chromaMultiplier) =>
			tune.identity && chromaMultiplier === 1
				? palette.tone(tone)
				: scaled(palette.hue, palette.chroma * chromaMultiplier, tune.tone(tone), tune.chromaFactor);

		const corrections = new Map();
		for (const [index, color] of overrides) {
			const a = labFromArgb(color);
			const b = labFromArgb(tuned(SHADE_TONES[index], 1));
			corrections.set(index, [a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
		}

		const correctionAt = (tone) => {
			if (overrides.size === 0) return null;
			let upper = -1;
			for (let i = 0; i < SHADE_TONES.length; i++) if (SHADE_TONES[i] > tone) upper = i;
			upper = clamp(upper, 0, SHADE_TONES.length - 2);
			const lower = upper + 1;
			const start = corrections.get(upper);
			const end = corrections.get(lower);
			if (!start && !end) return null;
			const fraction = clamp((SHADE_TONES[upper] - tone) / (SHADE_TONES[upper] - SHADE_TONES[lower]), 0, 1);
			const s = start ?? [0, 0, 0];
			const e = end ?? [0, 0, 0];
			return [0, 1, 2].map((k) => s[k] + (e[k] - s[k]) * fraction);
		};

		const colorAt = (tone, chromaMultiplier = 1) => {
			const index = SHADE_TONES.findIndex((t) => Math.abs(t - tone) < 0.001);
			if (overrides.has(index)) return overrides.get(index);
			const color = tuned(tone, chromaMultiplier);
			const correction = correctionAt(tone);
			if (!correction) return color;
			const lab = labFromArgb(color);
			return argbFromLab(clamp(lab[0] + correction[0], 0, 100), lab[1] + correction[1], lab[2] + correction[2]);
		};

		return { colorAt, shades: SHADE_TONES.map((tone) => colorAt(tone)) };
	}

	function shadeOverrides(theme, roleIndex) {
		const overrides = new Map();
		for (const [name, hex] of Object.entries(theme.colorOverrides ?? {})) {
			const cut = name.lastIndexOf("_");
			if (name.slice(0, cut) !== ROW_NAMES[roleIndex] || !HEX.test(hex)) continue;
			const index = SHADES.indexOf(name.slice(cut + 1));
			if (index >= 0) overrides.set(index, argbFromHex(hex) >>> 0 | 0xff000000);
		}
		return overrides;
	}

	function overrideColor(value, shades) {
		const link = SHADE_LINK.exec(value ?? "");
		if (link) {
			const row = ROW_NAMES.indexOf(link[1]);
			const index = SHADES.indexOf(link[2]);
			if (row < 0 || index < 0) return null;
			const shade = shades[row][index];
			return link[3] ? ((shade & 0xffffff) | (parseInt(link[3], 16) << 24)) >>> 0 : shade;
		}
		const custom = CUSTOM_COLOR.exec(value ?? "");
		return custom ? parseInt(custom[1], 16) >>> 0 : null;
	}

	const toHex = (argb) => {
		const alpha = (argb >>> 24) & 0xff;
		const hex = hexFromArgb(argb | 0xff000000);
		return alpha === 0xff ? hex : hex + alpha.toString(16).padStart(2, "0");
	};

	function resolve(theme, isDark, seedHex, sliders) {
		const scheme = schemeFor(theme, seedHex, isDark);
		const accurateShades = theme.accurateShades ?? true;
		const pitchBlack = Boolean(theme.pitchBlack);
		const blackContainers = Boolean(theme.pitchBlackContainers) && pitchBlack;
		const tintText = theme.tintText ?? true;

		const palettes = Object.fromEntries(
			ROLES.map((role, i) => [
				role,
				adjustedPalette(paletteOf(scheme, role), tuning(role, theme.style, sliders, accurateShades), shadeOverrides(theme, i)),
			]),
		);
		const shades = ROLES.map((role) =>
			palettes[role].shades.map((color, index) =>
				pitchBlack && isDark && isNeutral(role) && index === SHADE_900 ? 0xff000000 : color,
			),
		);

		const surfaceTone = colors.surface().getTone(scheme);
		const tokenOverrides = (isDark ? theme.tokenOverrides?.dark : theme.tokenOverrides?.light) ?? {};
		const cache = new Map();

		const token = (name) => {
			if (cache.has(name)) return cache.get(name);
			const override = overrideColor(tokenOverrides[resourceName(name)], shades);
			let argb = override;
			if (argb == null) {
				const dc = colors[name]?.();
				if (!dc) return null;
				const role = roleOf(scheme, dc.palette(scheme));
				let tone = dc.getTone(scheme);
				if (role && pitchBlack && isDark && isNeutral(role) && SURFACE_TOKENS.has(name)) {
					tone = blackContainers && name === "surfaceContainer"
						? 0
						: Math.max(0, tone - surfaceTone) * PITCH_BLACK_SPREAD;
				}
				if (!tintText && SURFACE_TEXT_TOKENS.has(name)) argb = isDark ? 0xffffffff : 0xff000000;
				else if (!tintText && name === "onError") argb = isDark ? 0xff000000 : 0xffffffff;
				else if (role) argb = palettes[role].colorAt(tone, dc.chromaMultiplier ? dc.chromaMultiplier(scheme) : 1);
				else argb = dc.getArgb(scheme);
			}
			const hex = toHex(argb >>> 0);
			cache.set(name, hex);
			return hex;
		};

		return {
			rows: shades.map((row) => row.map((argb) => toHex(argb >>> 0))),
			role: token,
		};
	}

	return { resolve };
}
