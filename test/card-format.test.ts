import { describe, expect, test } from "vitest";
import { cardSignature, formatRelativeTime } from "../src/ui/card-format";
import { ParsedComment } from "../src/format/types";

const comment = (over: Partial<ParsedComment>): ParsedComment => ({
	id: "x",
	open: { from: 0, to: 5 },
	close: { from: 10, to: 15 },
	body: { from: 16, to: 40 },
	status: "open",
	thread: [{ author: "me", text: "hi" }],
	reactions: [],
	...over,
});

describe("cardSignature", () => {
	test("changes when any rendered field changes", () => {
		const base = cardSignature(comment({}));
		expect(cardSignature(comment({ status: "resolved" }))).not.toBe(base);
		expect(cardSignature(comment({ thread: [{ author: "me", text: "edited" }] }))).not.toBe(base);
		expect(cardSignature(comment({ reactions: [{ emoji: "👍", authors: ["me"] }] }))).not.toBe(base);
		// Anchoredness is part of the signature (a card that loses its anchor must redraw).
		expect(cardSignature(comment({ close: null }))).not.toBe(base);
	});

	test("ignores document position (marker offsets) so a moved comment doesn't churn", () => {
		const a = cardSignature(comment({ open: { from: 0, to: 5 }, close: { from: 10, to: 15 } }));
		const b = cardSignature(comment({ open: { from: 100, to: 105 }, close: { from: 110, to: 115 } }));
		expect(a).toBe(b);
	});
});

describe("formatRelativeTime", () => {
	test("empty for missing or invalid input", () => {
		expect(formatRelativeTime(undefined)).toBe("");
		expect(formatRelativeTime("not a date")).toBe("");
	});

	test("buckets recent times", () => {
		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		expect(formatRelativeTime(ago(10 * 1000))).toBe("just now");
		expect(formatRelativeTime(ago(5 * 60 * 1000))).toBe("5m");
		expect(formatRelativeTime(ago(3 * 60 * 60 * 1000))).toBe("3h");
		expect(formatRelativeTime(ago(2 * 24 * 60 * 60 * 1000))).toBe("2d");
	});

	test("falls back to an absolute date past a week", () => {
		const out = formatRelativeTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
		expect(out).not.toMatch(/^\d+[mhd]$/);
		expect(out).not.toBe("just now");
	});
});
