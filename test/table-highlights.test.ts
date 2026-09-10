import { describe, expect, test } from "vitest";
import { parseComments } from "../src/format/parse";
import {
	mapTableWidgets,
	tableCellForRange,
	tableHighlightName,
	tableHighlightRule,
	tableHighlightTargets,
} from "../src/editor/table-highlights";

describe("tableHighlightTargets", () => {
	test("maps header and body comments to rendered table cells", () => {
		const doc = [
			"| <!--c:h1-->Day<!--/c:h1--> | Note |",
			"| --- | --- |",
			"| Friday | <!--c:t1-->ship<!--/c:t1--> |",
			'<!--co:h1 by:me at:2026-01-01T00:00:00.000Z status:resolved quote:"Day"',
			"me: header",
			"-->",
			'<!--co:t1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"ship"',
			"me: body",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([
			{ table: 0, row: 0, column: 0, id: "h1", quote: "Day", resolved: true, author: "me" },
			{ table: 0, row: 1, column: 1, id: "t1", quote: "ship", resolved: false, author: "me" },
		]);
	});

	test("tracks multiple tables and tables without outer pipes", () => {
		const doc = [
			"A | B",
			"--- | ---",
			"one | <!--c:a1-->two<!--/c:a1-->",
			"",
			"| C | D |",
			"| --- | --- |",
			"| <!--c:b1-->three<!--/c:b1--> | four |",
			'<!--co:a1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"two"',
			"me: first",
			"-->",
			'<!--co:b1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"three"',
			"me: second",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([
			{ table: 0, row: 1, column: 1, id: "a1", quote: "two", resolved: false, author: "me" },
			{ table: 1, row: 1, column: 0, id: "b1", quote: "three", resolved: false, author: "me" },
		]);
	});

	test("stops a pipe table where Obsidian stops it, not at the last line with a pipe", () => {
		// Obsidian continues an outer-pipe table only while a line STARTS with a pipe.
		// Treating any line containing one as a row used to claim the prose below as
		// row 2 and hunt for a cell the rendered table doesn't have.
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"| Monday | spec |",
			"Prose with a | pipe and a <!--c:bb22-->commented phrase<!--/c:bb22--> here.",
			'<!--co:bb22 by:me at:2026-01-01T00:00:00.000Z status:open quote:"commented phrase"',
			"me: hi",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([]);
	});

	test("stops at a row whose leading pipe a comment marker displaced", () => {
		// Anchoring a whole row puts the opening marker before the leading pipe, which
		// drops that row out of the table — so no cell exists to highlight.
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			'<!--co:aa11 by:me at:2026-01-01T00:00:00.000Z status:open quote:"| Monday | spec |"',
			"me: hi",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([]);
	});

	test("accepts the single-dash delimiter row Obsidian allows", () => {
		const doc = [
			"| Day | Task |",
			"| - | :-: |",
			"| Monday | <!--c:aa11-->spec<!--/c:aa11--> |",
			'<!--co:aa11 by:me at:2026-01-01T00:00:00.000Z status:open quote:"spec"',
			"me: hi",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([
			{ table: 0, row: 1, column: 1, id: "aa11", quote: "spec", resolved: false, author: "me" },
		]);
	});

	test("ignores a pipe line that no delimiter row follows", () => {
		const doc = [
			"Shopping | list",
			"eggs | <!--c:aa11-->milk<!--/c:aa11-->",
			'<!--co:aa11 by:me at:2026-01-01T00:00:00.000Z status:open quote:"milk"',
			"me: hi",
			"-->",
		].join("\n");

		expect(tableHighlightTargets(doc, parseComments(doc))).toEqual([]);
	});

	test("places an anchor spanning two rows on the row it starts in", () => {
		// It can't be painted — no one cell holds it — but its card still belongs
		// beside that row rather than at the top of the table.
		const doc = ["| Day | Task |", "| --- | --- |", "| Monday | spec |", "| Tuesday | review |"].join("\n");
		const from = doc.indexOf("spec");
		const range = { from, to: doc.indexOf("review") + "review".length };

		expect(tableCellForRange(doc, range)).toEqual({ table: 0, row: 1, column: 1, whole: false });
		expect(tableCellForRange(doc, { from, to: from + 4 })).toEqual({
			table: 0,
			row: 1,
			column: 1,
			whole: true,
		});
	});

	test("uses separate stable registry names for each color and state", () => {
		expect(tableHighlightName("#0090ff", false)).toBe("document-comments-table-open-0090ff");
		expect(tableHighlightName("#0090ff", true)).toBe("document-comments-table-resolved-0090ff");
		expect(tableHighlightName("#e54d2e", false)).not.toBe(tableHighlightName("#0090ff", false));
		expect(tableHighlightName(null, false)).toBe("document-comments-table-open-default");
	});

	test("gives the hovered comment its own registry name and stronger rule", () => {
		// A CSS Custom Highlight carries no element, so `is-active` has nowhere to
		// live — the hovered range moves to a separate name with its own rule.
		expect(tableHighlightName("#0090ff", false, true)).toBe("document-comments-table-open-active-0090ff");
		expect(tableHighlightName("#0090ff", true, true)).toBe("document-comments-table-resolved-active-0090ff");
		expect(tableHighlightName("#0090ff", false, true)).not.toBe(tableHighlightName("#0090ff", false));

		// Matches the 18% / 38% pair the DOM highlight uses for prose.
		expect(tableHighlightRule("#0090ff", false, true)).toContain("color-mix(in srgb, #0090ff 38%, transparent)");
		expect(tableHighlightRule("#0090ff", true, true)).toContain("color-mix(in srgb, #0090ff 38%, transparent)");
	});

	test("renders open and resolved table colors with distinct treatments", () => {
		expect(tableHighlightRule("#0090ff", false)).toContain("background-color: color-mix");
		expect(tableHighlightRule("#0090ff", false)).toContain("text-decoration-style: solid");
		expect(tableHighlightRule("#e54d2e", true)).toContain("background-color: transparent");
		expect(tableHighlightRule("#e54d2e", true)).toContain("text-decoration-style: dashed");
		expect(tableHighlightRule("#e54d2e", true)).toContain("text-decoration-color: #e54d2e");
		expect(tableHighlightRule(null, false)).toContain("var(--text-normal)");
	});

	test("maps mounted table widgets by source position when earlier tables are virtualized", () => {
		const doc = [
			"| A |",
			"| --- |",
			"| one |",
			"",
			"| B |",
			"| --- |",
			"| two |",
			"",
			"| C |",
			"| --- |",
			"| three |",
		].join("\n");
		const mounted = [{ position: doc.indexOf("| B |") }, { position: doc.indexOf("| C |") }];

		const mapped = mapTableWidgets(doc, mounted, (widget) => widget.position);

		expect(mapped.get(1)).toBe(mounted[0]);
		expect(mapped.get(2)).toBe(mounted[1]);
		expect(mapped.has(0)).toBe(false);
	});
});
