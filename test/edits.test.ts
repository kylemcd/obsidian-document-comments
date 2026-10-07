import { describe, it, expect } from "vitest";
import {
	applyChanges,
	blockEnd,
	computeAddComment,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	findHighlightAtSelection,
} from "../src/editor/edits";
import { anchorRange, parseComments } from "../src/format/parse";
import { closeMarker, openMarker } from "../src/format/serialize";
import { anchorDamage } from "../src/editor/anchor-repair";

const DOC = "We should ship on Friday regardless of the QA timeline.\n\nNext paragraph.\n";
const FROM = DOC.indexOf("ship on Friday");
const TO = FROM + "ship on Friday".length;

const add = (): string => {
	const changes = computeAddComment(DOC, FROM, TO, {
		id: "k3f9",
		createdAt: "2026-06-17T10:00:00.000Z",
		author: "kyle",
		text: "I thought we agreed Thursday?",
	}).unwrap();
	return applyChanges(DOC, changes);
};

describe("computeAddComment", () => {
	it("wraps the selection and appends a body", () => {
		const out = add();
		const c = parseComments(out)[0];
		expect(c.id).toBe("k3f9");
		expect(c.author).toBe("kyle");
		expect(c.thread[0].text).toBe("I thought we agreed Thursday?");
		expect(out.slice(anchorRange(c)!.from, anchorRange(c)!.to)).toBe("ship on Friday");
	});

	it("places markers and body exactly", () => {
		const out = add();
		expect(out).toContain(openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9"));
		expect(out).toContain("QA timeline.\n<!--co:k3f9");
	});

	it("creates a highlight when the comment text is empty", () => {
		const out = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "2026-06-17T10:00:00.000Z",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const comment = parseComments(out)[0];

		expect(comment.thread).toEqual([]);
		expect(out.slice(anchorRange(comment)!.from, anchorRange(comment)!.to)).toBe("ship on Friday");
		expect(out).toContain('<!--co:h1 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"\n-->');
	});

	it("does not create a highlight when empty comments are disabled", () => {
		const changes = computeAddComment(DOC, FROM, TO, {
			id: "h1",
			createdAt: "t",
			author: "kyle",
			text: "",
			allowEmpty: false,
		}).unwrap();

		expect(changes).toEqual([]);
		expect(applyChanges(DOC, changes)).toBe(DOC);
	});

	it("keeps and converts an existing empty comment when new empty comments are disabled", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const range = anchorRange(parseComments(highlighted)[0])!;
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, range.from, range.to, {
				id: "unused",
				createdAt: "t2",
				author: "sam",
				text: "Can we ship Thursday?",
				allowEmpty: false,
			}).unwrap(),
		);
		const comments = parseComments(out);

		expect(comments).toHaveLength(1);
		expect(comments[0].id).toBe("h1");
		expect(comments[0].thread).toEqual([{ author: "sam", timestamp: "t2", text: "Can we ship Thursday?" }]);
		expect(out).not.toContain("unused");
	});

	it("removes an existing highlight with an empty submission even when empty comments are disabled", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const range = anchorRange(parseComments(highlighted)[0])!;
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, range.from, range.to, {
				id: "unused",
				createdAt: "t2",
				author: "sam",
				text: "",
				allowEmpty: false,
			}).unwrap(),
		);

		expect(out).toBe(DOC);
	});

	it("appends to the captured empty comment after another reply arrives", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const changed = applyChanges(
			highlighted,
			computeAppendReply(highlighted, "h1", { createdAt: "t2", author: "sam", text: "Remote reply" }).unwrap(),
		);
		const range = anchorRange(parseComments(changed)[0])!;
		const out = applyChanges(
			changed,
			computeAddComment(changed, range.from, range.to, {
				id: "unused",
				targetHighlightId: "h1",
				createdAt: "t3",
				author: "kyle",
				text: "Local reply",
			}).unwrap(),
		);
		const comments = parseComments(out);

		expect(comments).toHaveLength(1);
		expect(comments[0].id).toBe("h1");
		expect(comments[0].thread.map((entry) => entry.text)).toEqual(["Remote reply", "Local reply"]);
		expect(out).not.toContain("unused");
	});

	it("refuses stale removal after the captured empty comment receives a reply", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const changed = applyChanges(
			highlighted,
			computeAppendReply(highlighted, "h1", { createdAt: "t2", author: "sam", text: "Remote reply" }).unwrap(),
		);
		const range = anchorRange(parseComments(changed)[0])!;
		const result = computeAddComment(changed, range.from, range.to, {
			id: "unused",
			targetHighlightId: "h1",
			createdAt: "t3",
			author: "kyle",
			text: "",
			allowEmpty: true,
		});

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toContain("now has text");
		expect(parseComments(changed)).toHaveLength(1);
		expect(changed).not.toContain("unused");
	});

	it("keeps the prose intact once markup is stripped", () => {
		const out = add();
		expect(stripComments(out)).toContain("We should ship on Friday regardless of the QA timeline.");
	});

	it("errs for an empty selection", () => {
		const result = computeAddComment(DOC, FROM, FROM, { id: "x", createdAt: "t", author: "a", text: "b" });
		expect(result.isErr()).toBe(true);
	});

	it("places markers outside inline-code backticks", () => {
		const doc = "| What |\n| --- |\n| `Spinner` |";
		const from = doc.indexOf("Spinner");
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, from + "Spinner".length, {
				id: "code1",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);

		expect(out).toContain("<!--c:code1-->`Spinner`<!--/c:code1-->");
		expect(out).not.toContain("`<!--c:code1-->");
		const comment = parseComments(out).find((entry) => entry.id === "code1");
		expect(comment?.quote).toBe("`Spinner`");
		expect(out.slice(anchorRange(comment!)!.from, anchorRange(comment!)!.to)).toBe("`Spinner`");
	});

	it("converts an inline-code highlight when the code text is selected again", () => {
		const doc = "Use `Spinner` here.";
		const originalFrom = doc.indexOf("Spinner");
		const highlighted = applyChanges(
			doc,
			computeAddComment(doc, originalFrom, originalFrom + "Spinner".length, {
				id: "h3",
				createdAt: "t1",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const from = highlighted.indexOf("Spinner");
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, from + "Spinner".length, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "Use the shared component.",
			}).unwrap(),
		);

		expect(parseComments(out)).toHaveLength(1);
		expect(parseComments(out)[0].id).toBe("h3");
		expect(parseComments(out)[0].thread[0].text).toBe("Use the shared component.");
	});

	it("supports inline code delimited by multiple backticks", () => {
		const doc = "Use ``Spinner ` icon`` here.";
		const from = doc.indexOf("Spinner");
		const to = from + "Spinner ` icon".length;
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, to, {
				id: "code2",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);

		expect(out).toContain("<!--c:code2-->``Spinner ` icon``<!--/c:code2-->");
	});
});

describe("reply / resolve", () => {
	it("appends a reply", () => {
		const out = applyChanges(
			add(),
			computeAppendReply(add(), "k3f9", {
				createdAt: "2026-06-17T11:00:00.000Z",
				author: "sam",
				text: "Thursday is better",
			}).unwrap(),
		);
		const c = parseComments(out)[0];
		expect(c.thread).toHaveLength(2);
		expect(c.thread[1]).toMatchObject({ author: "sam", text: "Thursday is better" });
	});

	it("toggles resolved status", () => {
		const resolved = applyChanges(add(), computeSetResolved(add(), "k3f9", true).unwrap());
		expect(parseComments(resolved)[0].status).toBe("resolved");
		const reopened = applyChanges(resolved, computeSetResolved(resolved, "k3f9", false).unwrap());
		expect(parseComments(reopened)[0].status).toBe("open");
	});

	it("errs when the comment id is unknown", () => {
		expect(computeSetResolved(add(), "nope", true).isErr()).toBe(true);
	});
});

describe("computeAddComment in code blocks", () => {
	it("creates a code comment (block wrap + line target) for a selection inside a fence", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore";
		const from = doc.indexOf("spinner");
		const result = computeAddComment(doc, from, from + "spinner".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isOk()).toBe(true);
		const out = applyChanges(doc, result.unwrap());
		expect(out).toContain("<!--c:x-->\n```js");
		const c = parseComments(out).find((entry) => entry.id === "x")!;
		expect(c.codeLines).toEqual({ from: 0, to: 0 });
		expect(c.quote).toBe("const spinner = 1;");
	});

	it("still anchors a normal prose selection outside any fence", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore prose here";
		const from = doc.indexOf("prose");
		const result = computeAddComment(doc, from, from + "prose".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isOk()).toBe(true);
		expect(parseComments(applyChanges(doc, result.unwrap()))[0]!.codeLines).toBeUndefined();
	});

	it("creates a code highlight when the comment text is empty", () => {
		const doc = "```js\nconst spinner = 1;\n```";
		const from = doc.indexOf("const spinner");
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, from + "const spinner = 1;".length, {
				id: "h2",
				createdAt: "t",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const comment = parseComments(out)[0];

		expect(comment.thread).toEqual([]);
		expect(comment.codeLines).toEqual({ from: 0, to: 0 });
	});

	it("converts and removes an existing code highlight through the same add flow", () => {
		const doc = "```js\nconst spinner = 1;\n```";
		const originalFrom = doc.indexOf("const spinner");
		const highlighted = applyChanges(
			doc,
			computeAddComment(doc, originalFrom, originalFrom + "const spinner = 1;".length, {
				id: "h2",
				createdAt: "t1",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const from = highlighted.indexOf("const spinner");
		const to = from + "const spinner = 1;".length;
		const promoted = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, to, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "Explain this.",
			}).unwrap(),
		);
		expect(parseComments(promoted)).toHaveLength(1);
		expect(parseComments(promoted)[0].thread[0].text).toBe("Explain this.");

		const removed = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, to, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "",
				allowEmpty: false,
			}).unwrap(),
		);
		expect(removed).toBe(doc);
	});
});

describe("computeDeleteComment", () => {
	it("round-trips back to the original document", () => {
		const out = add();
		const restored = applyChanges(out, computeDeleteComment(out, "k3f9").unwrap());
		expect(restored).toBe(DOC);
	});

	it("removes duplicated markers left by copy-pasting a commented span", () => {
		const out = add();
		// Simulate a paste: duplicate the anchor markers elsewhere in the doc.
		const anchor = openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9");
		const withDupe = out.replace("Next paragraph.", "Next paragraph. " + anchor);
		expect(withDupe.match(/<!--c:k3f9-->/g)!.length).toBe(2);
		const cleaned = applyChanges(withDupe, computeDeleteComment(withDupe, "k3f9").unwrap());
		expect(cleaned).not.toContain("k3f9");
	});

	// Deletes on the raw-file path (sidebar / Reading view) see the file's real line
	// endings. A code comment's own-line markers must take their whole CRLF terminator
	// with them, or a `\r\n` is left behind as a stray blank line around the block.
	it("round-trips a code-block comment on a CRLF file without leaving blank lines", () => {
		const base = "intro\n\n```js\nconst a = 1;\n```\n\noutro\n";
		const at = base.indexOf("const a = 1;");
		const withComment = applyChanges(
			base,
			computeAddComment(base, at, at + "const a = 1;".length, {
				id: "cc1",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);
		const toCrlf = (s: string): string => s.replace(/\n/g, "\r\n");
		const crlf = toCrlf(withComment);
		const restored = applyChanges(crlf, computeDeleteComment(crlf, "cc1").unwrap());
		expect(restored).toBe(toCrlf(base));
	});
});

describe("malformed / boundary edit inputs", () => {
	it("errs on a reversed from/to being empty after the swap", () => {
		expect(computeAddComment(DOC, TO, FROM, { id: "x", createdAt: "t", author: "a", text: "b" }).isOk()).toBe(true);
		// A reversed zero-width range is still empty.
		expect(computeAddComment(DOC, FROM, FROM, { id: "x", createdAt: "t", author: "a", text: "b" }).isErr()).toBe(
			true,
		);
	});

	it("errs when the captured selection no longer matches (expected guard)", () => {
		const result = computeAddComment(DOC, FROM, TO, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
			expected: "something else entirely",
		});
		expect(result.isErr()).toBe(true);
	});

	it("errs on an out-of-range entry edit instead of a silent no-op write", () => {
		const out = add();
		expect(computeEditEntry(out, "k3f9", 99, "nope").isErr()).toBe(true);
		expect(computeDeleteEntry(out, "k3f9", -1).isErr()).toBe(true);
	});

	it("errs when replying to a comment that has no body", () => {
		const markerOnly = openMarker("m1") + "x" + closeMarker("m1");
		expect(computeSetResolved(markerOnly, "m1", true).isErr()).toBe(true);
		expect(computeAppendReply(markerOnly, "m1", { createdAt: "t", author: "a", text: "b" }).isErr()).toBe(true);
	});
});

describe("blockEnd", () => {
	it("stops at the blank line after a paragraph", () => {
		expect(blockEnd(DOC, TO)).toBe(DOC.indexOf("\n"));
	});
	it("returns doc length when no trailing newline", () => {
		const d = "single line no newline";
		expect(blockEnd(d, 3)).toBe(d.length);
	});
});

const stripComments = (s: string): string => {
	return s.replace(/<!--\/?co?:[A-Za-z0-9]+[\s\S]*?-->/g, "");
};

// A comment starting a line's text used to put `<!--` first on the line, which
// Reading view takes for a raw HTML block and shows without formatting (#94).
describe("comments that start a line", () => {
	const G = "\u200b";
	const addAt = (doc: string, from: number, to: number, text = "note"): string => {
		const changes = computeAddComment(doc, from, to, { id: "a1", createdAt: "t", author: "me", text }).unwrap();
		return applyChanges(doc, changes);
	};
	const anchored = (doc: string): string => {
		const range = anchorRange(parseComments(doc).find((comment) => comment.id === "a1")!)!;
		return doc.slice(range.from, range.to);
	};

	it("guards a comment on a paragraph's first word", () => {
		const doc = "Hello ==World== and **bold**\n";
		const out = addAt(doc, 0, 2);

		expect(out.startsWith(`${G}<!--c:a1-->He<!--/c:a1-->llo ==World==`)).toBe(true);
		expect(anchored(out)).toBe("He");
		expect(parseComments(out)[0]?.quote).toBe("He");
	});

	it.each([
		["a list item", "- One item ==hl==", "- ", G],
		["a numbered item", "1. One item ==hl==", "1. ", G],
		["a task", "- [ ] One item ==hl==", "- [ ] ", G],
		["a quote", "> One item ==hl==", "> ", G],
		["a callout title", "> [!note] One item ==hl==", "> [!note] ", G],
		["a heading", "## One item ==hl==", "## ", ""],
	])("anchors a triple-clicked %s after its markup", (_label, doc, markup, guard) => {
		const out = addAt(doc, 0, doc.length);

		expect(out.startsWith(`${markup}${guard}<!--c:a1-->One item ==hl==<!--/c:a1-->`)).toBe(true);
		expect(anchored(out)).toBe("One item ==hl==");
	});

	it("guards a comment starting a paragraph's second line", () => {
		const doc = "First line\nSecond line ==hl==\n";
		const out = addAt(doc, doc.indexOf("Second"), doc.indexOf(" line =="));

		expect(out).toContain(`First line\n${G}<!--c:a1-->Second<!--/c:a1--> line ==hl==`);
	});

	it("leaves a comment in the middle of a line unguarded", () => {
		const doc = "Hello ==World==\n";
		const out = addAt(doc, 6, 15);

		expect(out).not.toContain(G);
	});

	it("brings an end at the start of the next line back to the text it ends on", () => {
		const doc = "- One\n- Two\n";
		const out = addAt(doc, 0, doc.indexOf("- Two"));

		expect(out.startsWith(`- ${G}<!--c:a1-->One<!--/c:a1-->\n`)).toBe(true);
		expect(out).toContain("\n- Two\n");
	});

	it.each([
		["a fence before a list item", "Intro text\n```\ncode\n```\n- Next item\n", "- Next", "- "],
		["a rule before a quote", "Intro text\n\n---\n> Quote here\n", "> Quote", "> "],
		["a rule before a heading", "Intro text\n\n---\n## Next\n", "## Next", "## "],
	])("keeps an end after %s off the markup when it can't move back", (_label, doc, next, markup) => {
		const out = addAt(doc, 0, doc.indexOf(next));
		const guard = markup === "## " ? "" : G;

		expect(out).toContain(`\n${markup}${guard}<!--/c:a1-->${next.slice(markup.length)}`);
		expect(anchorDamage(out).size).toBe(0);
	});

	// A marker after a whitespace-only line's indentation starts a code block past four
	// columns, or joins the paragraphs that line kept apart. The start moves on to
	// the text instead, leaving the line as it was.
	it.each([
		["four spaces between paragraphs", "Para one\n    \nNext para\n", "    "],
		["a tab after a blank line", "Para one\n\n\t\nNext para\n", "\t"],
	])("starts a selection on a line of %s on the text after it", (_label, doc, space) => {
		const line = doc.indexOf(`\n${space}\n`) + 1;
		const end = doc.indexOf("Next para") + "Next para".length;

		for (const from of [line, line + space.length]) {
			expect(addAt(doc, from, end)).toContain(`\n${space}\n${G}<!--c:a1-->Next para<!--/c:a1-->`);
		}
	});

	// Obsidian keeps one list either way, but the blank line is what makes it loose,
	// and other Markdown tools split the list at a comment line between items.
	it("starts a selection on the blank line between list items on the next item's text", () => {
		const doc = "- One\n\n- Two\n";
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.indexOf("Two") + 3);

		expect(out.startsWith(`- One\n\n- ${G}<!--c:a1-->Two<!--/c:a1-->`)).toBe(true);
	});

	// A marker in front of `$$` or `%%` stops the line opening a math or comment
	// block, which then shows as text and swallows what follows its closing line.
	it.each([
		["a math block", "Intro paragraph.\n\n$$\nE = mc^2\n$$\n\nThe equation is famous.\n"],
		["a comment block", "Intro paragraph.\n\n%%\nhidden note\n%%\n\nThe equation is famous.\n"],
		["an HTML block", "Intro paragraph.\n\n<div>\nboxed\n</div>\n\nThe equation is famous.\n"],
	])("keeps a start on a blank line above %s on the blank line", (_label, doc) => {
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.indexOf("famous") + 6);

		expect(out).toContain("Intro paragraph.\n<!--c:a1-->\n");
	});

	it.each([
		["a lone tag", "Intro paragraph.\n\n<details>\nmore\n</details>\n\nThe equation is famous.\n"],
		["an unclosed comment", "Intro paragraph.\n\n<!--\nnote\n-->\n\nThe equation is famous.\n"],
	])("keeps a start on a blank line above %s on the blank line", (_label, doc) => {
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.indexOf("famous") + 6);

		expect(out).toContain("Intro paragraph.\n<!--c:a1-->\n");
	});

	// Inline HTML followed by text is an ordinary line of text, not an HTML block.
	it.each([
		[
			"a list item's second paragraph",
			"- item one\n\n  <b>Note:</b> continued para\n",
			"  ",
			"<b>Note:</b> continued para",
		],
		["a loose list's next item", "- One\n\n- <b>Two</b> item\n", "- ", "<b>Two</b> item"],
		[
			"an ordered item's second paragraph",
			"1. First\n\n   <kbd>Ctrl</kbd> then C\n",
			"   ",
			"<kbd>Ctrl</kbd> then C",
		],
	])("moves a start on a blank line on to %s that opens with inline HTML", (_label, doc, markup, text) => {
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.length - 1);

		expect(out).toContain(`\n\n${markup}${G}<!--c:a1-->${text}<!--/c:a1-->`);
	});

	it("looks past a line of nothing but a comment", () => {
		const doc = "Intro\n\n<!-- note -->\nText here\n";
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.length - 1);

		expect(out).toContain(`<!-- note -->\n${G}<!--c:a1-->Text here<!--/c:a1-->`);
	});

	it("anchors a start on a rule on the inline HTML line after it", () => {
		const doc = "Para\n\n---\n<b>Bold</b> start of next\n";
		const out = addAt(doc, doc.indexOf("---"), doc.length - 1);

		expect(out).toContain(`---\n${G}<!--c:a1--><b>Bold</b> start of next<!--/c:a1-->`);
	});

	it("keeps a start on a blank line above a fence, where the marker stays invisible", () => {
		const doc = "Intro\n\n```\ncode\n```\nAfter\n";
		const out = addAt(doc, doc.indexOf("\n\n") + 1, doc.indexOf("After") + 5);

		expect(out).toContain("Intro\n<!--c:a1-->\n```");
	});

	it.each([
		["a rule", "Para\n\n---\nNext text\n", "---"],
		["a setext underline", "Title\n=====\nNext text\n", "====="],
		["an empty bullet", "- \n- Next text\n", "- "],
	])("starts a selection on %s on the text after it", (_label, doc, line) => {
		const at = doc.indexOf(`${line}\n`);
		for (const from of [at, at + 1, at + line.length]) {
			const out = addAt(doc, from, doc.indexOf("text") + 4);
			expect(out).toContain(`${line}\n`);
			expect(out).toMatch(/\n(?:- )?\u200b<!--c:a1-->Next text<!--\/c:a1-->/);
		}
	});

	it.each([
		["a rule", "Para text\n\n---\n"],
		["a setext underline", "Title text\n=====\n"],
	])("ends a selection on %s on the text before it", (_label, doc) => {
		for (const to of [doc.length - 1, doc.length - 3, doc.lastIndexOf("\n", doc.length - 2) + 1]) {
			const out = addAt(doc, 0, to);
			expect(out).toMatch(/^\u200b<!--c:a1-->\w+ text<!--\/c:a1-->\n/);
		}
	});

	it("errs on a selection of nothing but a rule", () => {
		const doc = "Para\n\n---\n\nNext\n";
		const from = doc.indexOf("---");
		const result = computeAddComment(doc, from, from + 3, { id: "a1", createdAt: "t", author: "me", text: "x" });

		expect(result.isErr() && result.error).toBe("Select some text to comment on.");
	});

	// `\<` is an escape, so a marker right after the backslash would show as text.
	// Obsidian's triple-click stops at the line's end; CodeMirror's takes the break.
	it.each([
		["the line's end", "Address line one\\".length],
		["the next line's start", "Address line one\\\n".length],
	])("ends a line selected to %s in front of its hard break's backslash", (_label, to) => {
		const doc = "Address line one\\\nAddress line two\n";

		expect(addAt(doc, 0, to)).toContain("Address line one<!--/c:a1-->\\\nAddress line two");
	});

	it("starts a selection right after a backslash in front of it", () => {
		const doc = "Hello \\*world*\n";
		const out = addAt(doc, doc.indexOf("*world"), doc.indexOf("\n"));

		expect(out).toContain("Hello <!--c:a1-->\\*world*<!--/c:a1-->");
	});

	// A marker anywhere in indented code shows as text in the code.
	it.each([
		["to the line's end", "    npm run build".length],
		["through the line break", "    npm run build\n".length],
		["part of it", "    npm".length],
	])("keeps a selection of a line of indented code %s out of the code", (_label, length) => {
		const doc = "Intro paragraph.\n\n    npm run build\n\nAfter.\n";
		const line = doc.indexOf("    npm");
		const out = addAt(doc, length === "    npm".length ? line + 4 : line, line + length);

		expect(out).toContain("Intro paragraph.\n<!--c:a1-->\n    npm run build\n<!--/c:a1-->\n");
		expect(out).not.toContain(G);
	});

	// No place in the middle of a code block hides a marker without breaking the
	// block, so the line goes on showing as text, as it always did.
	it("keeps the markers of a comment on a middle line of indented code at its start and end", () => {
		const doc = "Intro\n\n    one\n    two\n    three\n\nAfter\n";
		const line = doc.indexOf("    two");
		const out = addAt(doc, line, line + "    two".length);

		expect(out).toContain("\n    one\n<!--c:a1-->    two<!--/c:a1-->\n    three\n");
	});

	it("errs on a selection of an indented code line's indentation alone", () => {
		const doc = "Intro\n\n    npm run build\n";
		const at = doc.indexOf("    npm");
		const result = computeAddComment(doc, at + 1, at + 3, { id: "a1", createdAt: "t", author: "me", text: "x" });

		expect(result.isErr() && result.error).toBe("Select some text to comment on.");
	});

	it.each([
		["the break after a line of indented code", "\n    two"],
		["the breaks between indented code and a list item", "\n\n1. Item"],
	])("errs on a selection of %s", (_label, after) => {
		const doc = `Intro\n\n    one${after}\n`;
		const at = doc.indexOf("one") + 3;
		const result = computeAddComment(doc, at, at + after.indexOf(after.trim()), {
			id: "a1",
			createdAt: "t",
			author: "me",
			text: "x",
		});

		expect(result.isErr() && result.error).toBe("Select some text to comment on.");
	});

	it("starts a selection from the end of a line of indented code on the line after it", () => {
		const doc = "Intro\n\n    code\n---\nNext text\n";
		const out = addAt(doc, doc.indexOf("\n---"), doc.indexOf("Next text") + "Next text".length);

		expect(out).toContain(`\n    code\n---\n${G}<!--c:a1-->Next text<!--/c:a1-->`);
	});

	it("keeps the markers of a comment on indented code before a rule on the line's start and end", () => {
		const doc = "Intro\n\n    code\n---\n";
		const line = doc.indexOf("    code");
		const out = addAt(doc, line, doc.indexOf("---"));

		expect(out).toContain("\n<!--c:a1-->    code<!--/c:a1-->\n---\n");
	});

	it("ends a selection at indented code after a rule on the text before the rule", () => {
		const doc = "Para text\n\n---\n    code\n";
		const out = addAt(doc, 0, doc.indexOf("    code"));

		expect(out).toContain(`${G}<!--c:a1-->Para text<!--/c:a1-->\n`);
		expect(out).toContain("\n---\n    code\n");
	});

	// A marker alone on the blank line after another would end the list there.
	it("starts a selection on the blank lines above an item's indented text on that text", () => {
		const doc = "- One\n\n\n    more of one\n";
		const out = addAt(doc, doc.indexOf("\n\n\n") + 2, doc.length - 1);

		expect(out).toContain(`\n\n\n    ${G}<!--c:a1-->more of one<!--/c:a1-->`);
	});

	it("errs on a selection of the space after a code line's dash", () => {
		const doc = "Intro\n\n    - code\n";
		const at = doc.indexOf("- code") + 1;
		const result = computeAddComment(doc, at, at + 1, { id: "a1", createdAt: "t", author: "me", text: "x" });

		expect(result.isErr() && result.error).toBe("Select some text to comment on.");
	});

	it("leaves a comment on a line of nothing but an HTML comment unguarded", () => {
		const doc = "Intro\n\n<!-- note -->\n";
		const at = doc.indexOf("<!--");
		const out = addAt(doc, at, at + "<!-- note -->".length);

		expect(out).toContain("\n<!--c:a1--><!-- note --><!--/c:a1-->\n");
	});

	it("keeps an end after a line of indented code off the end of the code", () => {
		const doc = "Intro.\n\n    npm run build\n- Next item\n";
		const out = addAt(doc, 0, doc.indexOf("- Next"));

		expect(out).toContain(`\n    npm run build\n- ${G}<!--/c:a1-->Next item`);
	});

	it("ends a selection on a whitespace line after a fence at the line's start", () => {
		const doc = "Intro\n```\ncode\n```\n    \nNext\n";
		const out = addAt(doc, 0, doc.indexOf("    \nNext") + 4);

		expect(out).toContain("```\n<!--/c:a1-->    \nNext");
	});

	it("starts a selection on an empty list item on the next item's text", () => {
		const doc = "- \n- Next item\n";
		const out = addAt(doc, 0, doc.indexOf("\n", 3));

		expect(out.startsWith(`- \n- ${G}<!--c:a1-->Next item<!--/c:a1-->`)).toBe(true);
		expect(anchorDamage(out).size).toBe(0);
	});

	it("puts a comment's body after a code block that follows its paragraph, not inside it", () => {
		const doc = "Para text\n```\ncode\n\nmore\n```\n\nNext\n";
		const out = addAt(doc, 0, 4);

		expect(out).toContain("\nmore\n```\n<!--co:a1");
		expect(parseComments(out)[0]?.body).not.toBeNull();
	});

	it("puts a comment's body before a code block with no closing fence", () => {
		const doc = "Para text\n```\ncode\n\nmore\n";
		const out = addAt(doc, 0, 4);

		expect(out).toContain("Para<!--/c:a1--> text\n<!--co:a1");
		expect(out.indexOf("<!--co:a1")).toBeLessThan(out.indexOf("```"));
	});

	it("errs on a comment in a code block with no closing fence", () => {
		const doc = "Intro\n\n```\ncode line\n";
		const at = doc.indexOf("code");
		const result = computeAddComment(doc, at, at + 4, { id: "a1", createdAt: "t", author: "me", text: "x" });

		expect(result.isErr() && result.error).toBe("Close the code block before commenting on it.");
	});

	it("shares a guard already starting the line", () => {
		const doc = `- ${G}<!--c:zz99-->Item<!--/c:zz99-->\n<!--co:zz99 by:me status:open quote:"Item"\nme: hi\n-->\n`;
		const out = addAt(doc, 0, doc.indexOf("\n"));

		const line = out.slice(0, out.indexOf("\n"));
		expect(line).toBe(`- ${G}<!--c:a1--><!--c:zz99-->Item<!--/c:zz99--><!--/c:a1-->`);
	});

	it("errs on a selection of nothing but block markup", () => {
		const doc = "- Item\n";
		const result = computeAddComment(doc, 0, 2, { id: "a1", createdAt: "t", author: "me", text: "x" });

		expect(result.isErr() && result.error).toBe("Select some text to comment on.");
	});

	it("finds the highlight it made when the same line is selected again", () => {
		const doc = "Hello world\n";
		const out = addAt(doc, 0, 5, "");
		const range = anchorRange(parseComments(out)[0]!)!;

		expect(findHighlightAtSelection(out, range.from, range.to)?.id).toBe("a1");
	});

	it.each([
		["a paragraph's first word", "Hello world\n\nNext.\n", 0, 5],
		["a triple-clicked list item", "- One\n- Two\n", 0, 5],
		["a quote", "> Quote\n", 0, 7],
	])("deletes a comment on %s back to the original document", (_label, doc, from, to) => {
		const out = addAt(doc, from, to);

		expect(applyChanges(out, computeDeleteComment(out, "a1").unwrap())).toBe(doc);
	});

	it("keeps a shared guard while another comment's marker still starts the line", () => {
		const doc = `${G}<!--c:a1--><!--c:b2-->Hello<!--/c:b2--><!--/c:a1-->\n`;
		const out = applyChanges(doc, computeDeleteComment(doc, "a1").unwrap());

		expect(out).toBe(`${G}<!--c:b2-->Hello<!--/c:b2-->\n`);
	});
});
