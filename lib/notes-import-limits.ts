/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;

/** The file types "Extract files" takes; the client check, server check and picker `accept` all derive from this list. */
const IMPORT_EXTENSION_NAMES = ["txt", "md", "markdown", "rst", "org", "adoc", "tex", "pdf"];
export const IMPORT_EXTENSIONS = new RegExp(`\\.(?:${IMPORT_EXTENSION_NAMES.join("|")})$`, "i");
export const IMPORT_ACCEPT = IMPORT_EXTENSION_NAMES.map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, or PDF.";

/** Image-only PDF pages (handwritten or scanned) are transcribed by the Vision
 * model. Above this many in one PDF, the learner confirms first. */
export const TRANSCRIBE_CONFIRM_ABOVE = 3;
/** Rough Vision-model cost of one page (image in, Markdown out), for the confirmation copy. */
export const TRANSCRIBE_TOKENS_PER_PAGE = 2500;
/** The import request's per-file answer to that confirmation (form field "imagePages"). */
export type ImagePagesDecision = "transcribe" | "skip";

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
