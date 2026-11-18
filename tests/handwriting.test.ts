/**
 * Handwritten/scanned page transcription for the notes import: reply parsing,
 * batching and partial failure on a faux engine + fake renderer, and the
 * import route's use of the seam (transcribed pages reach the pipeline).
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { parseTranscription, transcribePdfPages } from "../src/agent/subagents/handwriting.ts";
import { POST } from "../app/api/graph/import/route.ts";
import { extraction, handwriting } from "../src/server/index.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

function fakeHeadless(calls: number[][]): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unused"); },
		renderSvg: async () => { throw new Error("unused"); },
		renderPdfPages: async (_pdfPath, pages) => {
			calls.push([...pages]);
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
}

function visionEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: { ...faux.getModel(), input: ["text", "image"] }, streamFn: faux.streamSimple };
}

/** The page numbers a request carried, read from its image labels. */
function requestedPages(context: Context): number[] {
	const content = context.messages.at(-1)?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => part.type === "text" ? [...part.text.matchAll(/IMAGE OF PAGE (\d+)/g)].map((m) => Number(m[1])) : []);
}

it("parses page sections, ignores unrequested pages and empty sections", () => {
	const reply = "preamble\n=== PAGE 2 ===\n# Titre\n\nTexte $x^2$\n=== PAGE 9 ===\nhors demande\n===PAGE 4===\n\n=== page 5 ===\n[blank page]";
	assert.deepEqual([...parseTranscription(reply, [2, 4, 5])], [[2, "# Titre\n\nTexte $x^2$"], [5, "[blank page]"]]);
});

it("transcribes in batches with images attached and reports pages of a failed batch", async () => {
	const renders: number[][] = [];
	const seen: number[][] = [];
	const engine = visionEngine([
		(context) => { const pages = requestedPages(context); seen.push(pages); return fauxAssistantMessage(pages.map((p) => `=== PAGE ${p} ===\nnote ${p}`).join("\n")); },
		(context) => { const pages = requestedPages(context); seen.push(pages); return fauxAssistantMessage(`=== PAGE ${pages[0]} ===\nonly first`); },
	]);
	const result = await transcribePdfPages({ pdfBytes: new Uint8Array([1]), pages: [7, 3, 5, 1], engine, headless: fakeHeadless(renders), batchSize: 2, concurrency: 1 });
	assert.deepEqual(renders, [[1, 3], [5, 7]]);
	assert.deepEqual(seen, [[1, 3], [5, 7]]);
	assert.deepEqual([...result.texts].sort(), [[1, "note 1"], [3, "note 3"], [5, "only first"]]);
	assert.deepEqual(result.failed, [7]);
});

it("a model error loses only its own batch", async () => {
	const engine = visionEngine([
		() => { throw new Error("boom"); },
		(context) => fauxAssistantMessage(requestedPages(context).map((p) => `=== PAGE ${p} ===\nok`).join("\n")),
	]);
	const result = await transcribePdfPages({ pdfBytes: new Uint8Array([1]), pages: [1, 2], engine, headless: fakeHeadless([]), batchSize: 1, concurrency: 1 });
	assert.deepEqual([...result.texts], [[2, "ok"]]);
	assert.deepEqual(result.failed, [1]);
});

it("a text-only model transcribes nothing", async () => {
	const engine = visionEngine([]);
	engine.model = { ...engine.model, input: ["text"] };
	const renders: number[][] = [];
	const result = await transcribePdfPages({ pdfBytes: new Uint8Array([1]), pages: [1], engine, headless: fakeHeadless(renders) });
	assert.deepEqual(result.failed, [1]);
	assert.deepEqual(renders, []);
});

const originalImport = extraction.importNotes;
const originalTranscribe = handwriting.transcribe;
const originalState = handwriting.state;
after(() => { extraction.importNotes = originalImport; handwriting.transcribe = originalTranscribe; handwriting.state = originalState; });

function upload(name: string, bytes: Uint8Array<ArrayBuffer>, imagePages?: string) {
	const form = new FormData();
	form.append("files", new File([bytes], name));
	if (imagePages !== undefined) form.append("imagePages", imagePages);
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}
const text = (t: string) => ({ runs: [{ text: t, x: 72, y: 700 }] });
const scans = (n: number) => Array.from({ length: n }, () => ({ image: true }));

it("the import route sends image-only pages to transcription and imports the result in page order", async () => {
	const received: string[] = [];
	extraction.importNotes = async ({ text }) => { received.push(text); return { nodes: 1, chains: 0 }; };
	handwriting.state = () => "on";
	let asked: readonly number[] = [];
	let pdfHeader = "";
	handwriting.transcribe = async (bytes, pages) => {
		asked = pages;
		pdfHeader = new TextDecoder().decode(bytes.subarray(0, 5));
		return { texts: new Map([[1, "Handwritten notes"]]), failed: [3] };
	};
	const pdf = tinyPdf([{ image: true }, text("Printed page"), { image: true }]);
	const { results } = await (await POST(upload("lecture.pdf", pdf))).json();
	assert.deepEqual(asked, [1, 3]);
	assert.equal(pdfHeader, "%PDF-", "the transcriber gets the intact PDF bytes");
	assert.equal(received.length, 1);
	assert.match(received[0]!, /^--- Page 1 ---\n\n> \*Automatic transcription[^\n]*\n\nHandwritten notes\n\n--- Page 2 ---\n\nPrinted page$/);
	assert.equal(results[0].ok, true);
	assert.equal(results[0].notice, "Scanned pages may have errors. Transcribed 1 handwritten or scanned page; check them in the graph. 1 image-only page could not be transcribed.");
});

it("a fully handwritten PDF imports when transcribed, and is refused when nothing could be read", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	handwriting.state = () => "on";
	handwriting.transcribe = async () => ({ texts: new Map([[1, "a"], [2, "b"]]), failed: [] });
	let { results } = await (await POST(upload("scan.pdf", tinyPdf(scans(2))))).json();
	assert.equal(results[0].ok, true);
	assert.equal(results[0].notice, "Scanned pages may have errors. Transcribed 2 handwritten or scanned pages; check them in the graph.");
	handwriting.transcribe = async () => ({ texts: new Map(), failed: [1] });
	({ results } = await (await POST(upload("scan.pdf", tinyPdf(scans(1))))).json());
	assert.equal(results[0].ok, false);
	assert.equal(results[0].error, "Could not transcribe any page.");
});

it("more than three image pages: no decision asks first and imports nothing", async () => {
	let imported = 0, transcribed = 0;
	extraction.importNotes = async () => { imported++; return { nodes: 0, chains: 0 }; };
	handwriting.state = () => "on";
	handwriting.transcribe = async () => { transcribed++; return { texts: new Map(), failed: [] }; };
	const response = await POST(upload("notebook.pdf", tinyPdf([text("Intro"), ...scans(4)])));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.deepEqual(results, [{ filePath: "notebook.pdf", requestIndex: 0, outcome: "confirm", ok: false, imagePages: 4 }]);
	assert.equal(imported, 0); assert.equal(transcribed, 0);
});

it("exactly three image pages transcribe without asking", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	handwriting.state = () => "on";
	let asked: readonly number[] = [];
	handwriting.transcribe = async (_bytes, pages) => { asked = pages; return { texts: new Map(pages.map((p) => [p, "x"])), failed: [] }; };
	const { results } = await (await POST(upload("three.pdf", tinyPdf(scans(3))))).json();
	assert.equal(results[0].outcome, "completed");
	assert.deepEqual(asked, [1, 2, 3]);
});

it("the learner's answer: transcribe sends every image page; skip imports the text pages only", async () => {
	const received: string[] = [];
	extraction.importNotes = async ({ text }) => { received.push(text); return { nodes: 0, chains: 0 }; };
	handwriting.state = () => "on";
	let asked: readonly number[] = [];
	handwriting.transcribe = async (_bytes, pages) => { asked = pages; return { texts: new Map(pages.map((p) => [p, `p${p}`])), failed: [] }; };
	const pdf = tinyPdf([text("Intro"), ...scans(4)]);
	let { results } = await (await POST(upload("notebook.pdf", pdf, "transcribe"))).json();
	assert.equal(results[0].outcome, "completed");
	assert.deepEqual(asked, [2, 3, 4, 5]);
	asked = [];
	({ results } = await (await POST(upload("notebook.pdf", pdf, "skip"))).json());
	assert.equal(results[0].outcome, "completed");
	assert.deepEqual(asked, [], "skip never calls the model");
	assert.equal(received.at(-1), "--- Page 1 ---\n\nIntro");
	assert.equal(results[0].notice, "Scanned pages may have errors. Skipped 4 image-only pages; not transcribed.");
	({ results } = await (await POST(upload("scan.pdf", tinyPdf(scans(4)), "skip"))).json());
	assert.equal(results[0].error, "This PDF has no text pages, and its image pages were not transcribed.");
});

it("the Settings → Graph switch off skips image pages without asking", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	handwriting.state = () => "off";
	let transcribed = 0;
	handwriting.transcribe = async () => { transcribed++; return null; };
	let { results } = await (await POST(upload("notebook.pdf", tinyPdf([text("Intro"), ...scans(5)])))).json();
	assert.equal(results[0].outcome, "completed");
	assert.equal(results[0].notice, "Scanned pages may have errors. Skipped 5 image-only pages; transcription is off in Settings → Graph.");
	({ results } = await (await POST(upload("scan.pdf", tinyPdf(scans(1))))).json());
	assert.equal(results[0].error, "This PDF has no text pages. Image-page transcription is off in Settings → Graph.");
	assert.equal(transcribed, 0);
});

it("an unknown decision value is refused before any work", async () => {
	extraction.importNotes = async () => { throw new Error("unreachable"); };
	const response = await POST(upload("notebook.pdf", tinyPdf(scans(1)), "maybe"));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "Invalid imagePages decision" });
});
