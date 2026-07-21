import { describe, expect, test } from "vitest";
import { parseComments } from "../src/format/parse";
import { tableHighlightTargets } from "../src/editor/table-highlights";

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
			{ table: 0, row: 0, column: 0, quote: "Day", resolved: true },
			{ table: 0, row: 1, column: 1, quote: "ship", resolved: false },
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
			{ table: 0, row: 1, column: 1, quote: "two", resolved: false },
			{ table: 1, row: 1, column: 0, quote: "three", resolved: false },
		]);
	});
});
