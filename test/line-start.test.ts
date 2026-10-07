import { describe, expect, test } from "vitest";
import {
	anchorOffBlockMarkup,
	endOfPlainTextBefore,
	endOfTextBefore,
	indentedCodeLines,
	leadingMarkup,
	needsMarkerGuard,
} from "../src/format/line-start";

describe("leadingMarkup", () => {
	test.each([
		["a paragraph", "Hello world", 0, false],
		["a continuation line's indent", "  continued", 2, false],
		["a bullet", "- item", 2, false],
		["a tab after the bullet", "-\titem", 2, false],
		["a numbered item", "12. item", 4, false],
		["a numbered item with a parenthesis", "1) item", 3, false],
		["a task box", "- [ ] task", 6, false],
		["a custom task status", "* [/] task", 6, false],
		["a quote", "> quote", 2, false],
		["a list in a quote", "> - item", 4, false],
		["a quote in a list", "- > quote", 4, false],
		["a callout title", "> [!note] Title", 10, false],
		["a folded callout title", "> [!tip]- Title", 10, false],
		["a footnote", "[^1]: Note", 6, false],
		["a heading", "## Heading", 3, true],
		["a heading in a quote", "> # Heading", 4, true],
	])("finds where the text starts after %s", (_label, line, end, heading) => {
		expect(leadingMarkup(line)).toEqual({ end, heading });
	});

	test.each([
		["a word glued to a dash", "-1 degrees"],
		["a decimal", "1.5 million"],
		["a tag", "#tag text"],
		["a task box with no bullet", "[x] done"],
		["a callout marker outside a quote", "[!note] Title"],
	])("reads %s as text", (_label, line) => {
		expect(leadingMarkup(line).end).toBe(0);
	});
});

describe("anchorOffBlockMarkup", () => {
	test("moves a start in front of a bullet onto the item's text, as a triple-click leaves it", () => {
		const doc = "- One item\n- Two item";
		expect(anchorOffBlockMarkup(doc, 0, "- One item".length)).toEqual({ from: 2, to: "- One item".length });
	});

	test.each([
		["a heading", "## Heading here", "## ".length],
		["a quote", "> Quote line", "> ".length],
		["a task", "- [ ] Task", "- [ ] ".length],
		["a callout title", "> [!note] Title", "> [!note] ".length],
	])("moves a line-start selection past %s's markup", (_label, doc, from) => {
		expect(anchorOffBlockMarkup(doc, 0, doc.length)).toEqual({ from, to: doc.length });
	});

	test("leaves a start in the middle of a line alone", () => {
		const doc = "- One item";
		expect(anchorOffBlockMarkup(doc, 6, 10)).toEqual({ from: 6, to: 10 });
	});

	test("moves a start on a blank line on to the text after it", () => {
		const doc = "Above\n\nBelow";
		expect(anchorOffBlockMarkup(doc, 6, doc.length)).toEqual({ from: 7, to: doc.length });
	});

	test("steps over a guard already starting the line, so the new marker shares it", () => {
		const doc = "- \u200b<!--c:aa11-->Item<!--/c:aa11-->";
		expect(anchorOffBlockMarkup(doc, 0, doc.length).from).toBe(3);
	});

	test("brings an end at the start of the next line back to the text it ends on", () => {
		const doc = "Hello world\nSecond line";
		expect(anchorOffBlockMarkup(doc, 0, doc.indexOf("Second"))).toEqual({ from: 0, to: "Hello world".length });
	});

	test("brings an end after the next item's bullet back, keeping trailing spaces outside", () => {
		const doc = "- One  \n- Two";
		expect(anchorOffBlockMarkup(doc, 2, doc.indexOf("Two"))).toEqual({ from: 2, to: "- One".length });
	});

	test.each([
		["a fence", "Text\n```\ncode\n```\nNext"],
		["a rule", "Text\n\n---\nNext"],
		["a table row", "| A | B |\n| - | - |\n| 1 | 2 |\n- Next"],
	])("keeps an end that would land at the end of %s", (_label, doc) => {
		const to = doc.indexOf("Next");
		expect(anchorOffBlockMarkup(doc, 0, to).to).toBe(to);
	});

	test("starts a triple-clicked line of indented code on the blank line above it", () => {
		const doc = "Intro\n\n    npm run build\n\nAfter";
		const end = doc.indexOf("\nAfter");

		expect(anchorOffBlockMarkup(doc, doc.indexOf("    npm"), end)).toEqual({ from: "Intro\n".length, to: end });
	});
});

describe("endOfTextBefore", () => {
	test.each([
		["LF", "Intro\n\n---\n- Item"],
		["CRLF", "Intro\r\n\r\n---\r\n- Item"],
	])("refuses the end of a rule with %s line endings", (_label, doc) => {
		expect(endOfTextBefore(doc, 0, doc.indexOf("- Item"))).toBeNull();
	});

	test("refuses the end of a line of indented code", () => {
		const doc = "Intro\n\n    npm run build\n- Item";
		expect(endOfTextBefore(doc, 0, doc.indexOf("- Item"))).toBeNull();
	});

	// `\<` is an escape, so a marker right after a backslash shows as text. In front
	// of it, the marker leaves the backslash ending the line as a hard break.
	test.each([
		["a hard break's backslash", "Line one\\\nNext", "Line one".length],
		["an escaped backslash", "Line one\\\\\nNext", "Line one\\\\".length],
		["an escaped backslash and a hard break", "Line one\\\\\\\nNext", "Line one\\\\".length],
	])("ends in front of %s that would escape the marker", (_label, doc, end) => {
		expect(endOfTextBefore(doc, 0, doc.indexOf("Next"))).toBe(end);
	});
});

describe("endOfPlainTextBefore", () => {
	test("ends in front of a hard break's backslash", () => {
		const doc = "Line one\\\n```\ncode\n```\nNext";
		expect(endOfPlainTextBefore(doc, 0, doc.indexOf("Next"))).toBe("Line one".length);
	});

	test("walks back past a line of indented code", () => {
		const doc = "Intro text\n\n    npm run build\n---\nNext";
		expect(endOfPlainTextBefore(doc, 0, doc.indexOf("---"))).toBe("Intro text".length);
	});
});

describe("indentedCodeLines", () => {
	const isCode = (doc: string, line: string): boolean => indentedCodeLines(doc)(doc.indexOf(line));

	test.each([
		["after a blank line", "Intro\n\n    code", "    code"],
		["at the start of the note", "    code\nText", "    code"],
		["after a heading", "## Title\n    code", "    code"],
		["after a rule", "Intro\n\n---\n    code", "    code"],
		["after another line of code", "Intro\n\n    one\n    two", "    two"],
		["after a blank line in the code", "Intro\n\n    one\n\n    two", "    two"],
		["indented by a tab", "Intro\n\n\tcode", "\tcode"],
		["four columns past a list item's text", "- Item\n\n      code", "      code"],
		["after a comment alone on its line", "Intro\n<!--c:aa11-->\n    code", "    code"],
		["behind a marker in front of it", "Intro\n\n<!--c:aa11-->    code", "<!--c:aa11-->    code"],
		["after code that looks like a list item", "Intro\n\n    - not an item\n      more code", "      more code"],
		["after a list a paragraph ended", "- Item\n\n  back out\n\nPara\n\n    code", "    code"],
		["after an item a less indented block ended", "  - Item\n\n back out\n\n    code", "    code"],
		// Checked against Obsidian's own rendering.
		["after a comment that ends a paragraph", "Para\n<!-- note -->\n    code", "    code"],
		["after a comment that ends a list", "- Item\n\n<!-- note -->\n\n    code", "    code"],
		["after a quote", "> Quote\n    code", "    code"],
		["after a bullet that carries on a paragraph", "Para\n    - x\n\n      deeper", "      deeper"],
		["after a heading that ends a list", "- Item\n## Heading\n    code", "    code"],
		["four columns past a footnote's text", "[^1]: First\n\n        code", "        code"],
		// Checked against Obsidian's own rendering.
		["after a comment that ends a footnote", "Text[^1]\n\n[^1]: Note\n<!-- c -->\n    code", "    code"],
		["after a quote that ends a footnote", "Text[^1]\n\n[^1]: Note\n> quote\n\n    code", "    code"],
		["after a footnote label that carries on a paragraph", "Text[^1]\nPara\n[^1]: Note\n\n    code", "    code"],
	])("finds a line of code %s", (_label, doc, line) => {
		expect(isCode(doc, line)).toBe(true);
	});

	test.each([
		["a paragraph's next line", "Intro\n    more intro", "    more intro"],
		["a list item's next line", "1. Item\n    more item", "    more item"],
		["a list item's second paragraph", "- Item\n\n    second para", "    second para"],
		["a nested item's paragraph", "- One\n\t- Two\n\n\t\tpara in two", "\t\tpara in two"],
		["a list item's paragraph after a lazy line", "- Item\nlazy line\n\n    para in item", "    para in item"],
		["a list item's paragraph behind its marker", "<!--c:aa11-->- Item\n\n    para in item", "    para in item"],
		["a nested item after a comment in its list", "- Item\n<!-- note -->\n    - nested", "    - nested"],
		["a list item's paragraph after its thread", "- Item\n<!--co:aa11 by:me\nme: hi\n-->\n\n    para", "    para"],
		["a quote's text in a list item", "- Item\n> quote\n    more", "    more"],
		["a footnote's second paragraph", "Text[^1]\n\n[^1]: First\n\n    Second", "    Second"],
		["a footnote's paragraph after a lazy line", "Text[^1]\n\n[^1]: Note\nlazy\n\n    more", "    more"],
		["a line in a fence", "```\n    code\n```", "    code"],
		["a line three spaces in", "Intro\n\n   text", "   text"],
	])("reads %s as text", (_label, doc, line) => {
		expect(isCode(doc, line)).toBe(false);
	});
});

describe("needsMarkerGuard", () => {
	test.each([
		["a paragraph's start", "Hello ==World==", 0],
		["a list item's text", "- item ==hl==", 2],
		["a quote's text", "> quote ==hl==", 2],
		["a callout title", "> [!note] Title ==hl==", 10],
		["a footnote", "[^1]: Note ==hl==", 6],
		["a soft-wrapped line", "First line\nSecond ==hl==", 11],
		["a header-only-pipes table's header", "a | b\n--|--\nc | d", 0],
	])("guards a marker starting %s", (_label, doc, pos) => {
		expect(needsMarkerGuard(doc, pos)).toBe(true);
	});

	test.each([
		["mid-line", "Hello ==World==", 6],
		["a heading's text", "## Heading ==hl==", 3],
		["a table's body row", "a | b\n--|--\nc | d", "a | b\n--|--\n".length],
		["the end of a line", "Hello\nWorld", 5],
		["a line with nothing after it", "Hello\n\nWorld", 6],
		["a line with nothing but a comment after it", "Hello\n\n<!-- note -->\nWorld", 7],
	])("leaves a marker at %s unguarded", (_label, doc, pos) => {
		expect(needsMarkerGuard(doc, pos)).toBe(false);
	});
});
