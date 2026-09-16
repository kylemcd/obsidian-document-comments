import { describe, expect, test } from "vitest";
import { applyChanges, computeAddComment } from "../src/editor/edits";
import { clampToTableCells, sourceLines, sourceTables } from "../src/format/table";

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
//
// Nor does a table start just anywhere: the tokenizer only looks for a header
// below a blank line, a heading, or the top of the note. Checked in the app, prose
// or a marker alone on the line above leaves the whole table as plain text.
const NORMAL_HEADER = /^\|(?:[^|]+\|)+?\s*$/;
const SIMPLE_HEADER = /^\s*[^|].*?\|.*[^|]\s*$/;
const DELIMITER_CELL = /^\s*:?\s*-+\s*:?\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
/** The part of a line still tokenized as Markdown (see above). */
const tokenizable = (line: string): string => {
	// A scan, not a transform: each step depends on where the previous comment
	// closed, and it exits at whichever of two conditions comes first.
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
	// Finds the first table, then consumes its variable run of rows from there —
	// two linked scans with an early exit, which no array method chain expresses.
	for (let i = 0; i + 1 < lines.length; i++) {
		const head = lines[i] ?? "";
		const delimiter = lines[i + 1] ?? "";
		const above = lines[i - 1];
		if (above !== undefined && above.trim() !== "" && !HEADING.test(above)) continue;
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

/** The span of `part` where it first appears inside `context`. */
const spanWithin = (doc: string, context: string, part: string): [number, number] => {
	const [start] = span(doc, context);
	const from = start + context.indexOf(part);
	return [from, from + part.length];
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

	// Only an end that lands in a table gets pulled inside its pipes. The other end
	// stays where the selection put it, so it can't be dragged onto a border.
	const between = ["Intro text", "", normal, "", "After."].join("\n");
	const headerOnly = ["Intro text", "", "| Day | Task |", "| --- | --- |", "", "After."].join("\n");
	test.each([
		["starts at the end of the paragraph above", between, between.indexOf("\n\n"), between.indexOf("ana") + 3],
		["starts on the blank line above", between, between.indexOf("\n\n") + 1, between.indexOf("ana") + 3],
		["ends on the blank line above, as a triple-click does", between, 0, between.indexOf("\n\n") + 1],
		[
			"ends on the blank line below a header-only table",
			headerOnly,
			headerOnly.indexOf("Day"),
			headerOnly.lastIndexOf("\n\n") + 1,
		],
		["ends at the start of the paragraph below", between, between.indexOf("write"), between.indexOf("After.")],
		[
			"starts after a table's last pipe and runs into the paragraph below",
			headerOnly,
			headerOnly.indexOf("| --- | --- |") + "| --- | --- |".length,
			headerOnly.length,
		],
	])("keeps a table rendering when a selection %s", (_label, doc, from, to) => {
		const out = addComment(doc, from, to);

		expect(out).not.toBeNull();
		expect(renderedRows(out ?? "")).toBe(renderedRows(doc));
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

	test.each([
		["where the header meets the delimiter", normal, ...span(normal, "|\n|")],
		["between two body rows", normal, ...spanWithin(normal, "ana |\n| Tuesday", "|\n|")],
		["around one cell separator", normal, ...spanWithin(normal, "Monday | write", " | ")],
		["around a pipe-less cell separator", simple, ...spanWithin(simple, "Monday | write", " | ")],
	])("refuses a selection of nothing but borders %s", (_label, doc, from, to) => {
		const result = computeAddComment(doc, from, to, {
			id: "aa11",
			createdAt: "2026-01-01T00:00:00.000Z",
			author: "me",
			text: "hi",
		});

		expect(result.isErr() && result.error).toBe("Select the text inside a table cell, not its borders.");
	});

	// A marker between a backslash and the pipe it escapes un-escapes that pipe: in
	// the app the cell splits in two and the marker itself shows as text.
	test.each([
		["the escaped pipe", "\\|", "\\|"],
		["just its pipe", "|", "\\|"],
		["text ending on its backslash", "this \\", "this \\|"],
		["text starting on its pipe", "| that", "\\| that"],
	])("keeps an escaped pipe whole when anchoring %s", (_label, part, anchored) => {
		const doc = ["| Day | Task |", "| --- | --- |", "| Monday | this \\| that |"].join("\n");
		const [from, to] = spanWithin(doc, "this \\| that", part);
		const [anchoredFrom, anchoredTo] = spanWithin(doc, "this \\| that", anchored);

		expect(clampToTableCells(doc, from, to)).toEqual({ from: anchoredFrom, to: anchoredTo });
	});

	test("treats a pipe after an escaped backslash as the separator it is", () => {
		const doc = ["| Day | Task |", "| --- | --- |", "| Monday | this \\\\| that |"].join("\n");
		const [from, to] = spanWithin(doc, "this \\\\| that", "this \\\\");

		expect(clampToTableCells(doc, from, to)).toEqual({ from, to });
	});

	test("writes the markers outside an escaped pipe, never between it and its backslash", () => {
		const doc = ["| Day | Task |", "| --- | --- |", "| Monday | this \\| that |"].join("\n");

		expect(addComment(doc, ...spanWithin(doc, "this \\| that", "|"))).toContain(
			"| Monday | this <!--c:aa11-->\\|<!--/c:aa11--> that |",
		);
	});

	test("leaves a collapsed selection alone", () => {
		const at = normal.indexOf("Monday");

		expect(clampToTableCells(normal, at, at)).toEqual({ from: at, to: at });
	});

	test("pulls a selection starting above a table into its first cell", () => {
		const out = addComment(between, between.indexOf("\n\n"), between.indexOf("ana") + 3);

		expect(out).toContain("Intro text\n\n| <!--c:aa11-->Day | Task | Owner |");
	});

	test("keeps a triple-clicked paragraph's markers off the blank line above a table", () => {
		const out = addComment(between, 0, between.indexOf("\n\n") + 1);

		expect(out).toContain("<!--c:aa11-->Intro text<!--/c:aa11-->\n");
		expect(out).toContain("-->\n\n| Day | Task | Owner |");
	});

	test("leaves a prose selection and its trailing whitespace exactly as they were", () => {
		// The blank line this one ends on sits above more prose, not a table.
		const doc = ["Intro text", "", "More prose.", "", normal].join("\n");
		const to = doc.indexOf("\n\n") + 1;

		expect(clampToTableCells(doc, 0, to)).toEqual({ from: 0, to });
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

// Every shape below is valid GFM, and every one renders as plain text in Obsidian
// — checked in the app, where only the control mounted a `.cm-table-widget`. A
// scanner that matched them would hand the margin row indices no widget has.
describe("recognizing only the tables Obsidian renders", () => {
	const tableCount = (doc: string) => sourceTables(sourceLines(doc)).length;

	test("finds a table with both outer pipes", () => {
		expect(tableCount("| Day | Task |\n| --- | --- |\n| Monday | spec |")).toBe(1);
	});

	test.each([
		["indented by spaces", "  | Day | Task |\n  | --- | --- |\n  | Monday | spec |"],
		["indented by a tab", "\t| Day | Task |\n\t| --- | --- |\n\t| Monday | spec |"],
		["nested in a list item", "- plan\n  | Day | Task |\n  | --- | --- |\n  | Monday | spec |"],
		["inside a blockquote", "> | Day | Task |\n> | --- | --- |\n> | Monday | spec |"],
		["headed with only a leading pipe", "| Day | Task\n| --- | ---\n| Monday | spec"],
		["headed with only a trailing pipe", "Day | Task |\n--- | --- |\nMonday | spec |"],
		["directly below a line of prose", "Intro text\n| Day | Task |\n| --- | --- |\n| Monday | spec |"],
		[
			"directly below a marker alone on its line",
			"<!--/c:aa11-->\n| Day | Task |\n| --- | --- |\n| Monday | spec |",
		],
		["directly below a comment's own block", '<!--co:aa11 quote:"x"\nme: hi\n-->\n| Day | Task |\n| --- | --- |'],
	])("finds no table %s", (_shape, doc) => {
		expect(tableCount(doc)).toBe(0);
	});

	test.each([
		["below a blank line", "Intro text\n\n| Day | Task |\n| --- | --- |\n| Monday | spec |"],
		["below a line of only spaces", "Intro text\n   \n| Day | Task |\n| --- | --- |\n| Monday | spec |"],
		["directly below a heading", "## Plan\n| Day | Task |\n| --- | --- |\n| Monday | spec |"],
	])("finds a table %s", (_shape, doc) => {
		expect(tableCount(doc)).toBe(1);
	});
});
