import { describe, expect, test } from "vitest";
import {
	anchorOffBlockMarkup,
	endOfPlainTextBefore,
	endOfTextBefore,
	footnoteRanges,
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
		["eight columns into an ordered item", "1. Step\n\n        code", "        code"],
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
		["after a raw HTML block a blank line ends", "<details>\nText\n1. Item\n\n    code", "    code"],
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
		// Checked in the app, an ordered item's text sits at least four columns in.
		["an ordered item's paragraph seven columns in", "1. Step\n\n       more", "       more"],
		["a list item's second paragraph", "- Item\n\n    second para", "    second para"],
		["a nested item's paragraph", "- One\n\t- Two\n\n\t\tpara in two", "\t\tpara in two"],
		["a list item's paragraph after a lazy line", "- Item\nlazy line\n\n    para in item", "    para in item"],
		["a list item's paragraph behind its marker", "<!--c:aa11-->- Item\n\n    para in item", "    para in item"],
		[
			"a line in a raw HTML block",
			"Intro\n\n<details><summary>More</summary>\n    indented line\n</details>",
			"    indented line",
		],
		[
			"a line in a raw HTML block after a rule in it",
			"Intro\n\n<details>\n---\n      deeper\n\nAfter",
			"      deeper",
		],
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

describe("footnoteRanges", () => {
	const G = String.fromCharCode(0x200b);
	const TEXT = "First line";
	const NOTE = `A[^1].\n\n[^1]: ${TEXT}`;
	const footnote = (doc: string, line: number): string | null => {
		const range = footnoteRanges(doc)(line);
		return range ? doc.slice(range.from, range.to).replace(/\r?\n$/, "") : null;
	};

	// Each checked against Obsidian's own rendering.
	test.each([
		["a lazy line", "\nlazy second line"],
		["a guarded marker's line", `\n${G}<!--c:aa11-->second<!--/c:aa11--> line`],
		["a numbered line that can't start a list here", "\n2. item"],
		["a paragraph four columns in", "\n\n    indented para"],
		["a paragraph after two blank lines", "\n\n\n    after two blanks"],
		["an indented line right after", "\n    indented directly"],
		["a line indented by a tab", "\n\n\ttab indented"],
		["a lazy line of its second paragraph", "\n\n    Second para\nlazy after second"],
		["code eight columns in", "\n\n        code"],
		["a line right after a fence in it", "\n\n    ```\n    code\n    ```\nlazy after fence"],
		["a line right after a heading in it", "\n\n    # Heading\nlazy after heading"],
	])("takes in %s", (_label, rest) => {
		expect(footnote(NOTE + rest, 2)).toBe(TEXT + rest);
	});

	test.each([
		["a paragraph after a blank line", "\n\nunindented para"],
		["an unguarded marker's line", "\n<!--c:aa11-->second<!--/c:aa11--> line"],
		["a comment", "\n<!-- note -->\n    indented after comment"],
		["a comment's thread", '\n<!--co:aa11 by:me status:open quote:"a"\nme: hi\n-->\n\n    after thread'],
		["a quote", "\n> quote"],
		["a bullet", "\n- item"],
		["a list numbered from one", "\n1. item"],
		["a heading", "\n# Heading"],
		["the next footnote", "\n[^2]: Second"],
		["a table", "\n| a | b |\n|---|---|\n| c | d |"],
		["a table without outer pipes", "\na | b\n--- | ---\nc | d"],
		["a rule", "\n***"],
		["a fence", "\n```\ncode\n```"],
		["an HTML block", "\n<div>x</div>"],
		["a math block", "\n$$\nx\n$$"],
	])("stops at %s", (_label, rest) => {
		expect(footnote(NOTE + rest, 2)).toBe(TEXT);
	});

	test("takes in the text under an empty label", () => {
		expect(footnote("A[^1].\n\n[^1]:\n    Content", 2)).toBe("\n    Content");
	});

	test("takes in text four columns past an indented label", () => {
		expect(footnote("A[^1].\n\n   [^1]: Note\n\n       more", 2)).toBe("Note\n\n       more");
	});

	test("reads Windows line endings", () => {
		expect(footnote("A[^1].\r\n\r\n[^1]: First\r\n\r\n    Second\r\n\r\nAfter", 2)).toBe("First\r\n\r\n    Second");
	});

	test.each([
		["a line with no footnote", "A[^1].\n\n[^1]: Note", 0],
		["a label four columns in, which is code", "A[^1].\n\n    [^1]: Note", 2],
		["a line past the end", "A[^1].\n\n[^1]: Note", 5],
	])("finds nothing on %s", (_label, doc, line) => {
		expect(footnote(doc, line)).toBeNull();
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
