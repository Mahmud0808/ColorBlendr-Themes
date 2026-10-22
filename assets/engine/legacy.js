// Renderer of the pre-token engine. Used only for schema v1 themes that carry
// shade overrides: their authors tuned the overrides against this mapping
// (token = fixed shade index, optional lightness nudge), so they keep it.

const HEX = /^#[0-9a-fA-F]{6}$/;
const SPEC_BY_VERSION = { 0: "2021", 1: "2025", 2: "2025" };
const TONES = [100, 99, 95, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const TINTS = TONES.map((t) => t / 100);
const SHADES = ["0", "10", "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"];
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
	tertiaryContainer: [2, 9, 3],
	onTertiaryContainer: [2, 3, 11],
	surface: [3, 11, 1, -25, -1],
	onSurface: [3, 2, 10],
	surfaceContainer: [3, 10, 2, -42, -2],
	surfaceContainerHigh: [3, 10, 1, null, -4],
	surfaceContainerHighest: [3, 10, 1, 3, -5],
	surfaceBright: [3, 10, 1, 13, -2],
	onSurfaceVariant: [4, 2, 10],
	outlineVariant: [4, 9, 4],
};

export function createLegacyRenderer(mcu) {
	const {
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
	} = mcu;

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

	function adjustSaturation(hex, saturation) {
		if (saturation === 100) return hex;
		const satF = (saturation - 100) / 100;
		const hct = Hct.fromInt(argbFromHex(hex));
		const target = Hct.from(hct.hue, 200, hct.tone);
		let chroma = hct.chroma;
		chroma += satF > 0 ? (target.chroma - chroma) * satF : chroma * satF;
		return hexFromArgb(Hct.from(hct.hue, chroma, hct.tone).toInt());
	}

	const toneOf = (hex) => Hct.fromInt(argbFromHex(hex)).tone;

	function atTone(hex, tone) {
		const h = Hct.fromInt(argbFromHex(hex));
		return hexFromArgb(Hct.from(h.hue, h.chroma, Math.max(0, Math.min(100, tone))).toInt());
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

	function buildRows(seedHex, theme, dark, sliders) {
		const style = theme.style ?? "TONAL_SPOT";
		const spec = SPEC_BY_VERSION[theme.colorSpecVersion] ?? "2021";
		const Ctor = SCHEME_BY_STYLE[style] ?? SchemeTonalSpot;
		const toneList = (palette) => TONES.map((t) => hexFromArgb(palette.tone(t)));
		const scheme = new Ctor(Hct.fromInt(argbFromHex(seedHex)), dark, 0, spec);
		const rows = [
			scheme.primaryPalette,
			scheme.secondaryPalette,
			scheme.tertiaryPalette,
			scheme.neutralPalette,
			scheme.neutralVariantPalette,
			scheme.errorPalette,
		].map(toneList);

		const ownPalette = (hex) => toneList(new Ctor(Hct.fromInt(argbFromHex(hex)), dark, 0, spec).primaryPalette);
		if (HEX.test(theme.secondaryColor ?? "")) rows[1] = ownPalette(theme.secondaryColor);
		if (HEX.test(theme.tertiaryColor ?? "")) rows[2] = ownPalette(theme.tertiaryColor);

		const mono = style === "MONOCHROMATIC";
		const rainbow = style === "RAINBOW";
		const pitch = Boolean(theme.pitchBlack);
		const accentSat = mono ? 100 : sliders.accentSat;
		const bgSat = mono ? 100 : sliders.bgSat;
		const bgLight = mono ? 100 : sliders.bgLight;

		rows.forEach((row, i) => {
			const accent = i <= 2 || i === 5;
			const neutral = i === 3 || i === 4;
			for (let j = 1; j < row.length; j++) {
				if (accent && accentSat !== 100 && !mono) {
					row[j] = adjustSaturation(row[j], accentSat);
				} else if (neutral) {
					if (bgLight !== 100 && !mono) row[j] = shiftLightness(row[j], bgLight, j);
					if (bgSat !== 100 && !mono && !rainbow) row[j] = adjustSaturation(row[j], bgSat);
				}
				if (mono) row[j] = shiftLightness(row[j], bgLight, j);
			}
			if (neutral && pitch) row[11] = "#000000";
		});

		for (const [name, hex] of Object.entries(theme.colorOverrides ?? {})) {
			if (!HEX.test(hex)) continue;
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

	function render(seedHex, theme, dark, sliders) {
		const rows = buildRows(seedHex, theme, dark, sliders);
		const role = (name) => {
			const entry = ROLE_MAP[name];
			if (!entry) return null;
			const [row, darkIdx, lightIdx, darkAdj, lightAdj] = entry;
			const hex = rows[row][dark ? darkIdx : lightIdx];
			const adj = dark ? darkAdj : lightAdj;
			return adj == null ? hex : adjustLightness(hex, adj);
		};
		return { rows, role };
	}

	return { render };
}
