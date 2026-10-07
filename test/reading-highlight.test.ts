// @vitest-environment happy-dom
//
// The Reading-view post-processor wraps each comment's anchored text in a
// `.doc-comment-span` so the highlight shows in rendered output. This covers the
// table case specifically: Live Preview can't highlight inside a table (Obsidian
// replaces it with a nested-editor widget our mark decoration can't reach), but
// Reading view walks the rendered DOM and *can*.
import { describe, expect, test } from "vitest";
import type { MarkdownPostProcessorContext } from "obsidian";
import { findSectionRange, highlightPostProcessor, mapReadingSelection, visibleText } from "../src/reading/highlight";
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
		expect(span?.getAttribute("data-dc-author")).toBe("me");
	});

	test("applies the original creator's configured color", () => {
		const doc = [
			"We ship on <!--c:p2-->Friday<!--/c:p2--> regardless.",
			'<!--co:p2 by:Alice at:2026-01-01T00:00:00.000Z status:resolved quote:"Friday"',
			"Alice: ok",
			"-->",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "We ship on Friday regardless.";

		highlightPostProcessor(el, ctxFor(doc, 0, 0), () => "#0090ff");
		const span = el.querySelector<HTMLElement>(".doc-comment-span[data-cid='p2']");

		expect(span?.dataset.dcAuthor).toBe("Alice");
		expect(span?.style.getPropertyValue("--dc-highlight-color")).toBe("#0090ff");
		expect(span?.classList.contains("is-resolved")).toBe(true);
	});

	test("uses the normal theme text color when an author has no mapping", () => {
		const doc = [
			"Ship <!--c:p3-->Friday<!--/c:p3-->.",
			'<!--co:p3 by:Alice status:open quote:"Friday"',
			"Alice: yes",
			"-->",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "Ship Friday.";

		highlightPostProcessor(el, ctxFor(doc, 0, 0), () => null);

		expect(el.querySelector<HTMLElement>(".doc-comment-span")?.style.getPropertyValue("--dc-highlight-color")).toBe(
			"var(--text-normal)",
		);
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

	test("ignores backticks inside raw HTML attributes", () => {
		const doc = [
			'<span title="`not > code`">x</span> and <!--c:i5-->`Spinner`<!--/c:i5-->.',
			'<!--co:i5 by:me at:2026-01-01T00:00:00.000Z status:open quote:"`Spinner`"',
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.innerHTML = '<span title="`not > code`">x</span> and <code>Spinner</code>.';

		highlightPostProcessor(el, ctxFor(doc, 0, 0));

		expect(el.querySelector("code > .doc-comment-span[data-cid='i5']")?.textContent).toBe("Spinner");
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

// A comment's text renders differently from its source whenever it carries
// Markdown, and often across several elements. Matching the raw source in one
// text node used to leave those comments with no highlight in Reading view.
describe("highlighting rendered text", () => {
	const G = String.fromCharCode(0x200b);
	const body = (id: string) => [`<!--co:${id} by:me status:open quote:"x"`, "me: ok", "-->"].join("\n");
	const highlighted = (el: HTMLElement, id: string): string =>
		[...el.querySelectorAll(`.doc-comment-span[data-cid='${id}']`)].map((span) => span.textContent).join("");
	const render = (html: string): HTMLElement => {
		const el = document.createElement("div");
		el.innerHTML = html;
		return el;
	};

	test("highlights text that carries a highlight and bold", () => {
		const doc = ["Hello <!--c:f1-->==World== and **bold**<!--/c:f1--> here.", body("f1")].join("\n");
		const el = render("<p>Hello <mark>World</mark> and <strong>bold</strong> here.</p>");
		highlightPostProcessor(el, ctxFor(doc, 0, 0));

		expect(highlighted(el, "f1")).toBe("World and bold");
		expect(el.querySelector("mark")?.textContent).toBe("World");
	});

	test("highlights the start of a guarded paragraph", () => {
		const doc = [`${G}<!--c:f2-->He<!--/c:f2-->llo ==World==`, body("f2")].join("\n");
		const el = render(`<p>${G}Hello <mark>World</mark></p>`);
		highlightPostProcessor(el, ctxFor(doc, 0, 0));

		expect(highlighted(el, "f2")).toBe("He");
	});

	test("highlights across a line break", () => {
		const doc = ["Alpha <!--c:f3-->beta", "gamma<!--/c:f3--> delta", body("f3")].join("\n");
		const el = render("<p>Alpha beta<br>\ngamma delta</p>");
		highlightPostProcessor(el, ctxFor(doc, 0, 1));

		expect(highlighted(el, "f3").replace(/\s+/g, " ")).toBe("beta gamma");
	});

	test("highlights the occurrence the comment is on, not the first", () => {
		const doc = ["the cat and <!--c:f4-->the<!--/c:f4--> dog", body("f4")].join("\n");
		const el = render("<p>the cat and the dog</p>");
		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		const span = el.querySelector(".doc-comment-span[data-cid='f4']");

		expect(span?.textContent).toBe("the");
		expect(span?.previousSibling?.textContent).toBe("the cat and ");
	});

	test("highlights each paragraph's part of a comment that spans two", () => {
		const doc = ["One <!--c:f5-->first part", "", "second part<!--/c:f5--> end.", body("f5")].join("\n");
		const first = render("<p>One first part</p>");
		const second = render("<p>second part end.</p>");
		highlightPostProcessor(first, ctxFor(doc, 0, 0));
		highlightPostProcessor(second, ctxFor(doc, 2, 2));

		expect(highlighted(first, "f5")).toBe("first part");
		expect(highlighted(second, "f5")).toBe("second part");
	});

	test("highlights a list item's text past its bullet", () => {
		const doc = [`- ${G}<!--c:f6-->Item **bold**<!--/c:f6-->`, body("f6")].join("\n");
		const el = render(`<ul><li><span class="list-bullet"></span>${G}Item <strong>bold</strong></li></ul>`);
		highlightPostProcessor(el, ctxFor(doc, 0, 0));

		expect(highlighted(el, "f6")).toBe("Item bold");
		expect(el.querySelector("ul > .doc-comment-span")).toBeNull();
	});

	test("highlights a code comment's line across syntax-highlighting tokens", () => {
		const doc = [
			"<!--c:k1-->",
			"```js",
			"const a = 1;",
			"```",
			"<!--/c:k1-->",
			'<!--co:k1 by:me status:open quote:"const a = 1;" line:0',
			"me: ok",
			"-->",
		].join("\n");
		const el = render(
			'<pre><code><span class="token keyword">const</span> a <span class="token operator">=</span> 1;</code></pre>',
		);
		highlightPostProcessor(el, ctxFor(doc, 1, 3));

		expect(highlighted(el, "k1")).toBe("const a = 1;");
	});
});

describe("visibleText", () => {
	test.each([
		["highlight and bold", "Hello ==World== and **bold**", "Hello World and bold"],
		[
			"a link and a wikilink with an alias",
			"See [the docs](https://x.y) and [[Note|this note]]",
			"See the docs and this note",
		],
		["inline code", "Run `npm test` now", "Run npm test now"],
		["list and quote markup", "- Item\n> Quote", "Item\nQuote"],
		["an escape and an entity", "A \\*star\\* &amp; more", "A *star* & more"],
		["an underscore inside a word", "snake_case_name", "snake_case_name"],
		["a lone asterisk between spaces", "2 * 3", "2 * 3"],
		["comment markers", "Ship <!--c:a1-->Friday<!--/c:a1-->", "Ship Friday"],
	])("drops the Markdown in %s", (_label, source, text) => {
		expect(visibleText(source).text).toBe(text);
	});

	test("maps each source offset to where it lands", () => {
		const { at } = visibleText("A **b** c");

		expect(at[2]).toBe(2);
		expect(at[4]).toBe(2);
		expect(at[5]).toBe(3);
		expect(at[9]).toBe(5);
	});
});

describe("code comments in a syntax-highlighted block", () => {
	test("wrap their line again when highlighting replaces the block's contents", async () => {
		const doc = [
			"<!--c:k2-->",
			"```js",
			"const answer = 42;",
			"```",
			"<!--/c:k2-->",
			'<!--co:k2 by:me status:open quote:"const answer = 42;" line:0',
			"me: ok",
			"-->",
		].join("\n");
		const el = document.createElement("div");
		el.innerHTML = "<pre><code>const answer = 42;</code></pre>";
		highlightPostProcessor(el, ctxFor(doc, 1, 3));
		expect(el.querySelector(".doc-comment-span[data-cid='k2']")?.textContent).toBe("const answer = 42;");

		// What Obsidian's highlighter does after the post-processors have run.
		el.querySelector("code")!.innerHTML =
			'<span class="token keyword">const</span> answer <span class="token operator">=</span> 42;';
		await new Promise((resolve) => setTimeout(resolve, 0));

		const spans = [...el.querySelectorAll(".doc-comment-span[data-cid='k2']")];
		expect(spans.map((span) => span.textContent).join("")).toBe("const answer = 42;");
	});
});
