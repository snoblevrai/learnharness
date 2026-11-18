import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, Message, TextContent, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";

/**
 * Transcription of image-only PDF pages (handwritten or scanned notes) for
 * the notes import. The import's text conversion skips pages without a text
 * layer; this module renders those pages and asks the Vision-slot model to
 * transcribe them, so their content can reach the graph like any other page.
 *
 * Pages go out in small batches (one model call per batch) with bounded
 * concurrency. A failed batch only loses its own pages: they are reported
 * back as failed and the import continues with what was transcribed.
 */

const INSTRUCTIONS = `You transcribe pages of a learner's study notes (handwritten or scanned) into Markdown.

Rules:
- Transcribe faithfully, in the page's original language. Do not summarize, translate, correct or complete the content.
- Keep the structure: headings, lists, numbered steps, tables, emphasis.
- Write formulas in LaTeX: $...$ inline, $$...$$ for display.
- For a drawing, diagram or figure, write one short line: [Figure: what it shows, with its labels].
- For a word you cannot read, write [illegible]. Never guess a whole passage.
- A page with nothing to transcribe gets the line [blank page].

Output format, and nothing else: for each page, a line "=== PAGE N ===" (N = the page number given with its image), then that page's transcription.`;

export interface HandwritingOptions {
	pdfBytes: Uint8Array;
	/** 1-based page numbers to transcribe (the image-only pages). */
	pages: readonly number[];
	engine: PiEngine;
	headless?: HeadlessApi;
	signal?: AbortSignal;
	/** Pages per model call. */
	batchSize?: number;
	/** Model calls in flight at once. */
	concurrency?: number;
	dpi?: number;
	onUsage?: (usage: Usage) => void;
}

export interface HandwritingResult {
	/** Page number → transcribed Markdown. */
	texts: Map<number, string>;
	/** Pages that could not be transcribed (render, model or parse failure). */
	failed: number[];
}

/** Split the model's reply on its "=== PAGE N ===" markers. Only requested
 *  pages are kept; empty sections count as missing. */
export function parseTranscription(reply: string, requested: readonly number[]): Map<number, string> {
	const wanted = new Set(requested);
	const out = new Map<number, string>();
	const parts = reply.split(/^[ \t]*=+[ \t]*PAGE[ \t]+(\d+)[ \t]*=+[ \t]*$/gim);
	for (let i = 1; i + 1 < parts.length; i += 2) {
		const page = Number(parts[i]);
		const text = parts[i + 1]!.trim();
		if (wanted.has(page) && text && !out.has(page)) out.set(page, text);
	}
	return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function callModel(engine: PiEngine, content: (TextContent | ImageContent)[], signal?: AbortSignal): Promise<{ text: string; usage: Usage }> {
	const messages: Message[] = [{ role: "user", content, timestamp: Date.now() }];
	const streamFn = workerRequestStream(engine.streamFn);
	const stream = streamFn(engine.model, normalizeContext({ systemPrompt: INSTRUCTIONS, messages, tools: [] }), {
		sessionId: randomUUID(),
		// Transcription needs reading, not reasoning: the lowest effort the model offers.
		reasoning: engine.model.reasoning ? "low" : undefined,
		signal,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") {
			const text = event.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			return { text, usage: event.message.usage };
		}
		if (event.type === "error") {
			if (event.reason === "aborted") throw Object.assign(new Error("aborted"), { name: "AbortError" });
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}

export async function transcribePdfPages(opts: HandwritingOptions): Promise<HandwritingResult> {
	const pages = [...new Set(opts.pages)].sort((a, b) => a - b);
	const texts = new Map<number, string>();
	const failed: number[] = [];
	if (pages.length === 0) return { texts, failed };
	if (!opts.engine.model.input.includes("image")) return { texts, failed: pages };

	const headless = opts.headless ?? getHeadless();
	const dpi = opts.dpi ?? 150;
	const batches = chunk(pages, Math.max(1, opts.batchSize ?? 3));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-handwriting-"));
	const pdfPath = path.join(dir, "notes.pdf");
	try {
		await fs.writeFile(pdfPath, opts.pdfBytes);
		const runBatch = async (batch: number[]) => {
			opts.signal?.throwIfAborted();
			try {
				const rendered = await headless.renderPdfPages(pdfPath, batch, { dpi });
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: `Transcribe these ${batch.length === 1 ? "page" : "pages"}: ${batch.join(", ")}.` },
				];
				const sent: number[] = [];
				for (const page of rendered) {
					const image = await processImage(page.png, "image/png", { resizeOptions: opts.engine.model.inputLimits?.images?.resize });
					if (!image.ok) continue;
					content.push({ type: "text", text: `=== IMAGE OF PAGE ${page.page} ===` }, { type: "image", data: image.data, mimeType: image.mimeType });
					sent.push(page.page);
				}
				if (sent.length === 0) { failed.push(...batch); return; }
				const { text, usage } = await callModel(opts.engine, content, opts.signal);
				opts.onUsage?.(usage);
				const parsed = parseTranscription(text, sent);
				for (const page of batch) {
					const transcription = parsed.get(page);
					if (transcription) texts.set(page, transcription);
					else failed.push(page);
				}
			} catch (error) {
				if (opts.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				console.warn(`[handwriting] pages ${batch.join(",")} failed: ${error instanceof Error ? error.message : String(error)}`);
				failed.push(...batch);
			}
		};
		const queue = [...batches];
		const workers = Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 2), queue.length) }, async () => {
			for (let batch = queue.shift(); batch; batch = queue.shift()) await runBatch(batch);
		});
		await Promise.all(workers);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	failed.sort((a, b) => a - b);
	return { texts, failed };
}
