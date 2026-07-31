// @vitest-environment happy-dom
//
// The Reading-view post-processor wraps each comment's anchored text in a
// `.doc-comment-span` so the highlight shows in rendered output. This covers the
// table case specifically: Live Preview can't highlight inside a table (Obsidian
// replaces it with a nested-editor widget our mark decoration can't reach), but
// Reading view walks the rendered DOM and *can*.
import { describe, expect, test } from "vitest";
import type { MarkdownPostProcessorContext } from "obsidian";
import { findSectionRange, highlightPostProcessor, mapReadingSelection } from "../src/reading/highlight";
import { anchorRange, parseComments } from "../src/format/parse";

Node.prototype.createSpan ??= function (o?: string | { cls?: string; text?: string; attr?: Record<string, string> }) {
	const el = document.createElement("span");
	if (typeof o === "string") {
		el.className = o;
	} else if (o) {
		if (o.cls) el.className = o.cls;
		if (o.text) el.textContent = o.text;
		for (const [key, value] of Object.entries(o.attr ?? {})) {
			el.setAttribute(key, value);
		}
	}
	this.appendChild(el);
	return el;
};

Node.prototype.detach ??= function () {
	this.parentNode?.removeChild(this);
};

// Minimal context: report the block's source + line span, like Obsidian does.
const ctxFor = (text: string, lineStart: number, lineEnd: number): MarkdownPostProcessorContext =>
	({ getSectionInfo: () => ({ text, lineStart, lineEnd }) }) as unknown as MarkdownPostProcessorContext;

describe("reading-view highlight post-processor", () => {
	test("wraps a comment anchor in a paragraph", () => {
		const doc = [
			"We ship on <!--c:p1-->Friday<!--/c:p1--> regardless.",
			'<!--co:p1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday"',
			"me: ok",
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "We ship on Friday regardless.";
		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const span = el.querySelector(".doc-comment-span[data-cid='p1']");
		expect(span?.textContent).toBe("Friday");
		expect(span?.getAttribute("title")).toBe("me: ok");
	});

	test("wraps an empty comment as a highlight without a preview", () => {
		const doc = [
			"We ship on <!--c:h1-->Friday<!--/c:h1--> regardless.",
			'<!--co:h1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "We ship on Friday regardless.";
		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const span = el.querySelector(".doc-comment-span[data-cid='h1']");

		expect(span?.textContent).toBe("Friday");
		expect(span?.hasAttribute("title")).toBe(false);
	});

	test("wraps an empty inline-code comment inside the rendered code element", () => {
		const doc = [
			"Use <!--c:i1-->`Spinner`<!--/c:i1--> here.",
			'<!--co:i1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"`Spinner`"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.innerHTML = "Use <code>Spinner</code> here.";

		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const span = el.querySelector("code > .doc-comment-span[data-cid='i1']");

		expect(span?.textContent).toBe("Spinner");
		expect(span?.hasAttribute("title")).toBe(false);
	});

	test("supports a multi-backtick inline-code highlight", () => {
		const doc = [
			"Use <!--c:i2-->``Spinner ` icon``<!--/c:i2--> here.",
			'<!--co:i2 by:me at:2026-01-01T00:00:00.000Z status:open quote:"``Spinner ` icon``"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.innerHTML = "Use <code>Spinner ` icon</code> here.";

		highlightPostProcessor(el, ctxFor(doc, 0, 0));

		expect(el.querySelector("code > .doc-comment-span[data-cid='i2']")?.textContent).toBe("Spinner ` icon");
	});

	test("wraps the anchored occurrence when inline code repeats", () => {
		const doc = [
			"Use `Spinner`, then <!--c:i3-->`Spinner`<!--/c:i3-->.",
			'<!--co:i3 by:me at:2026-01-01T00:00:00.000Z status:open quote:"`Spinner`"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.innerHTML = "Use <code>Spinner</code>, then <code>Spinner</code>.";
		document.body.appendChild(el);

		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const codes = el.querySelectorAll("code");
		const span = codes[1]?.querySelector<HTMLElement>(".doc-comment-span[data-cid='i3']") ?? null;

		expect(codes[0]?.querySelector(".doc-comment-span")).toBeNull();
		expect(span?.textContent).toBe("Spinner");

		const selection = window.getSelection();
		const section = span ? findSectionRange(span) : null;
		expect(selection).not.toBeNull();
		expect(section).not.toBeNull();
		if (selection && section && span) {
			const range = document.createRange();
			range.selectNodeContents(span);
			selection.removeAllRanges();
			selection.addRange(range);
			const target = anchorRange(parseComments(doc)[0]!)!;

			expect(mapReadingSelection(selection, section, doc)).toEqual({
				...target,
				expected: "`Spinner`",
			});
			selection.removeAllRanges();
		}
		el.remove();
	});

	test("keeps raw HTML code from shifting the Markdown code target", () => {
		const doc = [
			"<code>Spinner</code> and <!--c:i4-->`Spinner`<!--/c:i4-->.",
			'<!--co:i4 by:me at:2026-01-01T00:00:00.000Z status:open quote:"`Spinner`"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.innerHTML = "<code>Spinner</code> and <code>Spinner</code>.";

		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const codes = el.querySelectorAll("code");

		expect(codes[0]?.querySelector(".doc-comment-span")).toBeNull();
		expect(codes[1]?.querySelector(".doc-comment-span[data-cid='i4']")?.textContent).toBe("Spinner");
	});

	test("preserves boundary whitespace when mapping an existing highlight", () => {
		const doc = [
			"Ship on <!--c:w1-->Friday <!--/c:w1-->without delay.",
			'<!--co:w1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday "',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "Ship on Friday without delay.";
		document.body.appendChild(el);
		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const span = el.querySelector<HTMLElement>(".doc-comment-span[data-cid='w1']");
		const selection = window.getSelection();
		const section = span ? findSectionRange(span) : null;

		expect(span?.textContent).toBe("Friday ");
		expect(selection).not.toBeNull();
		expect(section).not.toBeNull();
		if (selection && section && span) {
			const range = document.createRange();
			range.selectNodeContents(span);
			selection.removeAllRanges();
			selection.addRange(range);
			const target = anchorRange(parseComments(doc)[0]!)!;

			expect(mapReadingSelection(selection, section, doc)).toEqual({
				...target,
				expected: "Friday ",
			});
			selection.removeAllRanges();
		}
		el.remove();
	});

	test("wraps a comment anchor that lands inside a table cell", () => {
		const doc = [
			"| Day | Note |",
			"| --- | --- |",
			"| <!--c:t1-->Friday<!--/c:t1--> | ship |",
			'<!--co:t1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday"',
			"me: ok",
			"-->",
			"",
		].join("\n");
		// Rendered table DOM — the HTML-comment markers are invisible in output.
		const el = document.createElement("div");
		el.innerHTML = "<table><tbody><tr><td>Friday</td><td>ship</td></tr></tbody></table>";
		highlightPostProcessor(el, ctxFor(doc, 0, 2));
		const span = el.querySelector(".doc-comment-span[data-cid='t1']");
		expect(span?.textContent).toBe("Friday");
		// …and it lands in the right cell, not elsewhere in the table.
		expect(span?.closest("td")?.textContent).toBe("Friday");
	});
});
