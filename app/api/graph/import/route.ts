/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files"); the pipeline mints a deterministic source id per file
 * path, persists the source record (the file's provenance + the run's usage),
 * and runs
 * extractor → auditor → merger over the raw text.
 *
 * Only filename extensions listed in lib/notes-import-limits.ts are taken.
 * Among those files, a PDF (spotted by its %PDF- header) is converted to
 * Markdown first; its image-only pages are transcribed by the Vision model
 * (Settings → Graph switch, confirmation above TRANSCRIBE_CONFIRM_ABOVE). Other files are decoded as UTF-8 unless a zero byte in
 * their first 8 KiB causes refusal. This is a binary-file heuristic, not
 * complete text or encoding validation. These refusals, and PDFs with
 * nothing to extract, occur before any source record or model call.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { convertPdf, extraction, handwriting, joinPages, NotesImportError, sourceDirectory } from "@/src/server";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES, TRANSCRIBE_CONFIRM_ABOVE, UNSUPPORTED_TYPE_MESSAGE, validNotesPath, type ImagePagesDecision } from "@/lib/notes-import-limits.ts";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import {
	emit,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	/** "confirm": nothing was imported; ask the learner, then send the file
	 *  again with an imagePages decision. */
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy" | "confirm";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** Shown beside a completed import (every PDF: scanner text may be wrong). */
	notice?: string;
	/** "confirm" only: how many image-only pages the PDF has. */
	imagePages?: number;
}

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const pagesWord = (count: number) => count === 1 ? "page" : "pages";

type NotesFileOrConfirm = NotesFile | { kind: "confirm"; imagePages: number };

/** A PDF becomes page-marked Markdown; any other accepted file is read as text.
 *  Image-only pages (handwritten or scanned) are transcribed by the Vision
 *  model when Settings → Graph allows it. Above TRANSCRIBE_CONFIRM_ABOVE such
 *  pages, a request without a decision gets "confirm" back instead: the client
 *  asks the learner, then sends the file again with the answer. */
async function readNotesFile(file: File, decision: ImagePagesDecision | undefined, signal?: AbortSignal): Promise<NotesFileOrConfirm> {
	if (!IMPORT_EXTENSIONS.test(file.name)) return { kind: "refused", error: UNSUPPORTED_TYPE_MESSAGE };
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		if (bytes.subarray(0, 8192).includes(0)) return { kind: "refused", error: "This file isn't plain text." };
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	// pdfjs may take ownership of the buffer it parses; keep a copy for rendering.
	const original = bytes.slice();
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const imagePages = pdf.pages.filter((page) => page.kind === "image-only").map((page) => page.number);
			const state = imagePages.length > 0 ? handwriting.state() : "off";
			if (state === "on" && decision === undefined && imagePages.length > TRANSCRIBE_CONFIRM_ABOVE) {
				return { kind: "confirm", imagePages: imagePages.length };
			}
			const transcription = state === "on" && decision !== "skip" ? await handwriting.transcribe(original, imagePages, signal) : null;
			const pages = transcription
				? pdf.pages.map((page) => {
					const transcribed = page.kind === "image-only" ? transcription.texts.get(page.number) : undefined;
					return transcribed === undefined ? page : {
						kind: "text" as const,
						number: page.number,
						markdown: `> *Automatic transcription of a handwritten or scanned page. It may contain errors.*\n\n${transcribed}`,
					};
				})
				: pdf.pages;
			const text = joinPages(pages);
			const skipped = pages.filter((page) => page.kind === "image-only").length;
			// Why the remaining image-only pages were left out.
			const reason = transcription ? "could not be transcribed"
				: state === "on" ? "not transcribed"
				: state === "off" ? "transcription is off in Settings → Graph"
				: "OCR is not supported";
			if (!text) {
				if (transcription) return { kind: "refused", error: "Could not transcribe any page." };
				if (state === "on") return { kind: "refused", error: "This PDF has no text pages, and its image pages were not transcribed." };
				return { kind: "refused", error: state === "off" ? "This PDF has no text pages. Image-page transcription is off in Settings → Graph." : "OCR not supported yet." };
			}
			const parts = [
				transcription && transcription.texts.size > 0 ? `Transcribed ${plural(transcription.texts.size, "handwritten or scanned page", "handwritten or scanned pages")}; check them in the graph.` : "",
				skipped > 0 ? (transcription ? `${plural(skipped, "image-only page", "image-only pages")} ${reason}.` : `Skipped ${skipped} image-only ${pagesWord(skipped)}; ${reason}.`) : "",
			].filter(Boolean);
			return { kind: "notes", text, notice: ["Scanned pages may have errors.", ...parts].join(" ") };
		}
	}
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json({ results: [] as ImportResult[], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "Too big. Max 25 MB." }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// PR198: folder-relative identity, matched to either browser filename form.
	// Validate every path before conversions, metadata writes, or model calls.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	// The learner's answer to the transcription confirmation, for every file in this request.
	const rawDecision = form.get("imagePages");
	if (rawDecision !== null && rawDecision !== "transcribe" && rawDecision !== "skip") {
		return Response.json({ results: [], error: "Invalid imagePages decision" }, { status: 400 });
	}
	const decision = rawDecision ?? undefined;
	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				const notes = await readNotesFile(file, decision, request.signal);
				if (notes.kind === "confirm") {
					results.push({ filePath, requestIndex, outcome: "confirm", ok: false, imagePages: notes.imagePages });
					continue;
				}
				if (notes.kind === "refused") {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats, ...(notes.notice ? { notice: notes.notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else {
					results.push({ filePath, requestIndex, ok: false,
						outcome: err instanceof NotesImportError ? err.outcome : "failed",
						...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
						error: err instanceof Error ? err.message : String(err) });
				}
			} finally { emit("sources-changed", {}); }
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}