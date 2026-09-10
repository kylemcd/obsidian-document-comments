import { describe, expect, test } from "vitest";
import { applyChanges, computeAddComment } from "../src/editor/edits";
import { clampToTableCells } from "../src/format/table";

// Obsidian keeps an outer-pipe table going only while a line STARTS with a pipe,
// and a pipe-less one while a line starts with a non-pipe and holds a pipe. A
// header is read only while it also ENDS with a pipe, and a delimiter row only
// while every cell is dashes and colons. Mirroring those rules here is what makes
// "the table still renders" an assertion rather than a hope.
//
// One rule isn't a line shape. A pipe only separates cells where the tokenizer
// still sees Markdown, so text after an HTML comment that does NOT close on the
// line contributes nothing. All three cases were checked in the app:
//
//   pipe-less table + `ordinary line | with a pipe`      -> grows a row
//   pipe-less table + `<!--co:… quote:"a | b"` (unclosed) -> does NOT
//   pipe-less row starting `<!--c:id-->Monday | spec`     -> still a row
//
// So a comment's own block can sit directly beneath a table, and a marker at the
// start of a pipe-less row is harmless. An outer-pipe row is different: its
// `^\|` test reads the raw line, so a marker before the leading pipe breaks it.
const NORMAL_HEADER = /^\|(?:[^|]+\|)+?\s*$/;
const SIMPLE_HEADER = /^\s*[^|].*?\|.*[^|]\s*$/;
const DELIMITER_CELL = /^\s*:?\s*-+\s*:?\s*$/;
/** The part of a line still tokenized as Markdown (see above). */
const tokenizable = (line: string): string => {
	let cursor = 0;
	for (;;) {
		const open = line.indexOf("<!--", cursor);
		if (open < 0) return line;
		const close = line.indexOf("-->", open + 4);
		if (close < 0) return line.slice(0, open);
		cursor = close + 3;
	}
};

const renderedRows = (doc: string): number | null => {
	const lines = doc.split("\n");
	for (let i = 0; i + 1 < lines.length; i++) {
		const head = lines[i] ?? "";
		const delimiter = lines[i + 1] ?? "";
		const normal = NORMAL_HEADER.test(head) && NORMAL_HEADER.test(delimiter);
		const simple = !normal && SIMPLE_HEADER.test(head) && SIMPLE_HEADER.test(delimiter);
		if (!normal && !simple) continue;
		const cells = normal ? delimiter.replace(/^\s*\|/, "").replace(/\|\s*$/, "") : delimiter;
		if (!cells.split("|").every((cell) => DELIMITER_CELL.test(cell))) continue;
		const isRow = (text: string) => (normal ? text.startsWith("|") : /^\s*[^|].*\|/.test(tokenizable(text)));
		let end = i + 2;
		while (end < lines.length && isRow(lines[end] ?? "")) end++;
		return end - i - 1;
	}
	return null;
};

const addComment = (doc: string, from: number, to: number): string | null => {
	const result = computeAddComment(doc, from, to, {
		id: "aa11",
		createdAt: "2026-01-01T00:00:00.000Z",
		author: "me",
		text: "hi",
	});
	return result.isErr() ? null : applyChanges(doc, result.value);
};

const normal = [
	"| Day | Task | Owner |",
	"| --- | --- | --- |",
	"| Monday | write the spec | ana |",
	"| Tuesday | review the spec | ben |",
].join("\n");
const simple = ["Day | Task", "--- | ---", "Monday | write the spec", "Tuesday | review the spec"].join("\n");

const span = (doc: string, text: string): [number, number] => {
	const from = doc.indexOf(text);
	expect(from, `missing ${text}`).toBeGreaterThanOrEqual(0);
	return [from, from + text.length];
};

describe("anchoring inside a table", () => {
	test.each([
		["one cell", ...span(normal, "write the spec")],
		["a whole row", ...span(normal, "| Monday | write the spec | ana |")],
		["the header row", ...span(normal, "| Day | Task | Owner |")],
		["two cells of one row", ...span(normal, "Monday | write the spec")],
		["two rows", ...span(normal, "write the spec | ana |\n| Tuesday | review")],
		["the whole table", 0, normal.length],
		["the header and delimiter", 0, normal.indexOf("| Monday") - 1],
	])("keeps an outer-pipe table rendering when anchoring %s", (_label, from, to) => {
		const out = addComment(normal, from, to);

		expect(out).not.toBeNull();
		expect(renderedRows(out ?? "")).toBe(renderedRows(normal));
	});

	test.each([
		["one cell", ...span(simple, "write the spec")],
		["a whole row", ...span(simple, "Monday | write the spec")],
		["the whole table", 0, simple.length],
	])("keeps a pipe-less table rendering when anchoring %s", (_label, from, to) => {
		const out = addComment(simple, from, to);

		expect(out).not.toBeNull();
		expect(renderedRows(out ?? "")).toBe(renderedRows(simple));
	});

	test("anchors a whole row inside its outer pipes", () => {
		const out = addComment(normal, ...span(normal, "| Monday | write the spec | ana |"));

		expect(out).toContain("| <!--c:aa11-->Monday | write the spec | ana<!--/c:aa11--> |");
	});

	test("refuses a selection holding nothing but borders and padding", () => {
		const [from, to] = span(normal, "|\n|");
		const result = computeAddComment(normal, from, to, {
			id: "aa11",
			createdAt: "2026-01-01T00:00:00.000Z",
			author: "me",
			text: "hi",
		});

		expect(result.isErr() && result.error).toBe("Select the text inside a table cell, not its borders.");
	});

	test("leaves a selection outside any table alone", () => {
		const doc = "Some prose with a | pipe in it.";

		expect(clampToTableCells(doc, 5, 10)).toEqual({ from: 5, to: 10 });
	});

	test("trims the border and padding a clamped selection picks up", () => {
		const [from, to] = span(normal, "| Monday ");

		expect(clampToTableCells(normal, from, to)).toEqual({
			from: normal.indexOf("Monday"),
			to: normal.indexOf("Monday") + "Monday".length,
		});
	});

	test("keeps an interior separator, which is a real multi-cell selection", () => {
		const [from, to] = span(normal, "Monday | write");

		expect(clampToTableCells(normal, from, to)).toEqual({ from, to });
	});
});
