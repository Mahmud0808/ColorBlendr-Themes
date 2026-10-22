// Picks the renderer for a theme. v1 themes with shade overrides and no
// engineVersion 2 marker keep the legacy renderer (matches the app's legacy
// token rule); everything else renders through the ported app engine.
import { createLegacyRenderer } from "./legacy.js";
import { createThemeEngine } from "./theme-engine.js";

const HEX = /^#[0-9a-fA-F]{6}$/;
const SITE_THEME = { style: "TONAL_SPOT", colorSpecVersion: 1 };

export function isLegacyTheme(theme) {
	return (
		(theme?.schemaVersion ?? 1) === 1 &&
		(theme?.engineVersion ?? 1) === 1 &&
		Object.keys(theme?.colorOverrides ?? {}).length > 0
	);
}

export function themeSliders(theme, isDark) {
	const light = !isDark && theme?.modeSpecificThemes;
	return {
		accentSat: (light ? theme.accentSaturationLight : theme?.accentSaturation) ?? 100,
		bgSat: (light ? theme.backgroundSaturationLight : theme?.backgroundSaturation) ?? 100,
		bgLight: (light ? theme.backgroundLightnessLight : theme?.backgroundLightness) ?? 100,
	};
}

export function createRenderer(mcu) {
	const engine = createThemeEngine(mcu);
	const legacy = createLegacyRenderer(mcu);

	return {
		render(theme, isDark, seedHex) {
			const source = theme ?? SITE_THEME;
			const seed = HEX.test(seedHex ?? "") ? seedHex : HEX.test(source.seedColor ?? "") ? source.seedColor : "#6750A4";
			const sliders = themeSliders(source, isDark);
			return isLegacyTheme(source)
				? legacy.render(seed, source, isDark, sliders)
				: engine.resolve(source, isDark, seed, sliders);
		},
	};
}
