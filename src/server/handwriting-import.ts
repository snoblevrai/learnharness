import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { transcribePdfPages, type HandwritingResult } from "../agent/subagents/handwriting.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ROLE_SLOT } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";

/** The Vision-slot engine (the pdf reader's role), or null when it is unset,
 *  its provider is unavailable, or the model cannot take images. Read fresh
 *  per import so a settings change applies to the next file. */
function visionEngine(): PiEngine | null {
	try {
		const settings = stores.settingsStore.readSettings();
		const spec = resolveRoleSpec("pdfReader", settings);
		if (!spec || !providerKeyPresent(spec.provider)) return null;
		const slot = ROLE_SLOT.pdfReader;
		const engine = piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention);
		return engine.model.input.includes("image") ? engine : null;
	} catch {
		return null;
	}
}

/** Why image-only pages are skipped, when they are. */
export type HandwritingState = "on" | "off" | "unavailable";

/** The notes import's handwriting seam (tests replace its members). */
export const handwriting: {
	/** "off" = Settings → Graph switch; "unavailable" = no image-capable Vision model. */
	state: () => HandwritingState;
	/** null = transcription unavailable: the import keeps skipping those pages. */
	transcribe: (pdfBytes: Uint8Array, pages: readonly number[], signal?: AbortSignal) => Promise<HandwritingResult | null>;
} = {
	state() {
		if (!effectiveSettings().graph.transcribeImagePages) return "off";
		return visionEngine() ? "on" : "unavailable";
	},
	async transcribe(pdfBytes, pages, signal) {
		const engine = visionEngine();
		if (!engine) return null;
		const started = Date.now();
		let input = 0, output = 0;
		const result = await transcribePdfPages({
			pdfBytes, pages, engine, signal,
			onUsage: (usage) => { input += usage.input + usage.cacheRead + usage.cacheWrite; output += usage.output; },
		});
		console.info(`[handwriting] ${result.texts.size}/${pages.length} pages transcribed (${result.failed.length} failed) in ${Date.now() - started} ms; tokens in=${input} out=${output}`);
		return result;
	},
};
