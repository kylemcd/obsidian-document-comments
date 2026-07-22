import { describe, expect, test } from "vitest";
import { stackTops } from "../src/ui/stack";

describe("stackTops", () => {
	test("returns tops in the original input order", () => {
		const tops = stackTops(
			[
				{ top: 200, height: 40 },
				{ top: 0, height: 40 },
			],
			8,
		);
		expect(tops).toEqual([200, 0]);
	});

	test("pushes an overlapping card down past the previous one plus the gap", () => {
		// Second card wants top 30 but the first occupies 0..40; it gets 40 + gap.
		expect(
			stackTops(
				[
					{ top: 0, height: 40 },
					{ top: 30, height: 20 },
				],
				8,
			),
		).toEqual([0, 48]);
	});

	test("keeps a card whose anchor scrolled above the viewport at its negative top", () => {
		// First floor is -Infinity, so the top card keeps its negative anchor top.
		const tops = stackTops(
			[
				{ top: -100, height: 40 },
				{ top: -50, height: 40 },
			],
			8,
		);
		expect(tops[0]).toBe(-100);
		expect(tops[1]).toBe(-50); // -50 already clears -100 + 40 + 8 = -52
	});

	test("stacks in anchor order regardless of input order", () => {
		const tops = stackTops(
			[
				{ top: 100, height: 40 },
				{ top: 0, height: 40 },
				{ top: 50, height: 40 },
			],
			8,
		);
		// sorted anchors 0, 50, 100 → 0, 50, 100 (none overlaps the previous + gap)
		expect(tops).toEqual([100, 0, 50]);
	});
});
