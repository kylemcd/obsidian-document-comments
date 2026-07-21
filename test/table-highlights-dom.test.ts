// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { textRangeForQuote } from "../src/editor/table-highlights";

describe("table highlight DOM ranges", () => {
	test("matches a raw Markdown quote against its rendered inline elements", async () => {
		const cell = document.createElement("div");
		cell.innerHTML = "Build a tiny core <code>Spinner</code> with <strong>CSS</strong> spin.";

		const match = await textRangeForQuote(cell, "`Spinner` with **CSS**", 0, async () => "Spinner with CSS");

		expect(match?.range.toString()).toBe("Spinner with CSS");
	});
});
