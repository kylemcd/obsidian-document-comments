import { describe, expect, test } from "vitest";
import { centeredScrollTop } from "../src/ui/scroll";

describe("centeredScrollTop", () => {
	test("moves upward to center a block above the viewport", () => {
		expect(centeredScrollTop(300, 40, 400, 2000)).toBe(120);
	});

	test("moves downward to center a block below the viewport", () => {
		expect(centeredScrollTop(1300, 40, 400, 2000)).toBe(1120);
	});

	test("clamps at the beginning and end of the document", () => {
		expect(centeredScrollTop(20, 40, 400, 2000)).toBe(0);
		expect(centeredScrollTop(1950, 40, 400, 2000)).toBe(1600);
	});
});
