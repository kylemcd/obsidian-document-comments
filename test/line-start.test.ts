import { describe, expect, test } from "vitest";
import { anchorOffBlockMarkup, leadingMarkup, needsMarkerGuard } from "../src/format/line-start";

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

	test("leaves a start on a blank line where the selection put it", () => {
		const doc = "Above\n\nBelow";
		expect(anchorOffBlockMarkup(doc, 6, doc.length)).toEqual({ from: 6, to: doc.length });
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
	])("leaves a marker at %s unguarded", (_label, doc, pos) => {
		expect(needsMarkerGuard(doc, pos)).toBe(false);
	});
});
