/**
 * SSR pins — the notes import's transcription question (image-only PDF
 * pages above TRANSCRIBE_CONFIRM_ABOVE). TranscribePagesBody is the pure
 * seam (the AbortTurnBody pattern); the wrapper owns the HostDialog.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscribePagesBody } from "@/components/notes-import";

describe("TranscribePagesBody", () => {
	it("names the file, the page count, the token estimate and the text-pages promise", () => {
		const html = renderToStaticMarkup(
			<TranscribePagesBody confirmation={{ index: 0, filePath: "Biology/week-3.pdf", imagePages: 6 }} onAnswer={() => {}} />,
		);
		assert.match(html, /Transcribe 6 image pages\?/);
		assert.match(html, /Biology\/week-3\.pdf/);
		assert.match(html, /about 15k tokens/);
		assert.match(html, /Text pages are imported either way\./);
	});

	it("offers No then Yes, with Yes as the neutral bordered action (not the destructive pair)", () => {
		const html = renderToStaticMarkup(
			<TranscribePagesBody confirmation={{ index: 0, filePath: "a.pdf", imagePages: 4 }} onAnswer={() => {}} />,
		);
		const no = html.indexOf('data-testid="transcribe-pages-no"');
		const yes = html.indexOf('data-testid="transcribe-pages-yes"');
		assert.ok(no > 0 && yes > no);
		assert.ok(!html.includes("destructive"));
	});

	it("each button answers with its decision", () => {
		const answers: string[] = [];
		const element = TranscribePagesBody({ confirmation: { index: 0, filePath: "a.pdf", imagePages: 4 }, onAnswer: (d) => answers.push(d) }) as React.ReactElement<{ children: React.ReactNode }>;
		const html = renderToStaticMarkup(element);
		assert.match(html, /No<\/button>/); assert.match(html, /Yes<\/button>/);
		const buttons: React.ReactElement<{ onClick: () => void; "data-testid": string }>[] = [];
		const walk = (node: React.ReactNode): void => {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) { node.forEach(walk); return; }
			const el = node as React.ReactElement<{ children?: React.ReactNode; onClick?: () => void; "data-testid"?: string }>;
			if (el.type === "button") buttons.push(el as never);
			walk(el.props.children);
		};
		walk(element);
		for (const b of buttons) b.props.onClick();
		assert.deepEqual(answers, ["skip", "transcribe"]);
	});
});
