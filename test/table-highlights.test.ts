import { describe, expect, test } from "vitest";
import { parseComments } from "../src/format/parse";
import {
	mapTableWidgets,
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
			{ table: 0, row: 0, column: 0, quote: "Day", resolved: true, author: "me" },
			{ table: 0, row: 1, column: 1, quote: "ship", resolved: false, author: "me" },
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
			{ table: 0, row: 1, column: 1, quote: "two", resolved: false, author: "me" },
			{ table: 1, row: 1, column: 0, quote: "three", resolved: false, author: "me" },
		]);
	});

	test("uses separate stable registry names for each color and state", () => {
		expect(tableHighlightName("#0090ff", false)).toBe("document-comments-table-open-0090ff");
		expect(tableHighlightName("#0090ff", true)).toBe("document-comments-table-resolved-0090ff");
		expect(tableHighlightName("#e54d2e", false)).not.toBe(tableHighlightName("#0090ff", false));
		expect(tableHighlightName(null, false)).toBe("document-comments-table-open-default");
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
