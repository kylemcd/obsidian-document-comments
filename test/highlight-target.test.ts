// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { visibleHighlightId } from "../src/ui/highlight-target";

const highlight = (cls = "doc-comment-span"): HTMLElement => {
	const span = document.createElement("span");
	span.className = cls;
	span.setAttribute("data-cid", "abc");
	return span;
};

describe("visibleHighlightId", () => {
	test("returns the comment id from a visible highlight or child target", () => {
		const span = highlight();
		const child = document.createElement("span");
		span.appendChild(child);
		expect(visibleHighlightId(span, true, true)).toBe("abc");
		expect(visibleHighlightId(child, true, true)).toBe("abc");
	});

	test("ignores highlights while comments are hidden", () => {
		expect(visibleHighlightId(highlight(), false, true)).toBeNull();
	});

	test("ignores resolved highlights while resolved comments are hidden", () => {
		expect(visibleHighlightId(highlight("doc-comment-span is-resolved"), true, false)).toBeNull();
	});
});
