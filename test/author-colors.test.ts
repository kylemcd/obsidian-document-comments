import { describe, expect, test } from "vitest";
import {
	AUTHOR_COLOR_PALETTE,
	canonicalAuthorKey,
	commentersForComments,
	creatorsForComments,
	effectiveHighlightColor,
	ensureAuthorColor,
	ensureAuthorColors,
	hydrateAuthorColors,
	hydrateExcludedAuthors,
	readAuthorColor,
	resetAuthorColor,
	type AuthorColorAssignments,
} from "../src/author-colors";
import { parseComments } from "../src/format/parse";

describe("author highlight colors", () => {
	test("assigns every palette color before reusing one", () => {
		const assignments: AuthorColorAssignments = {};
		const firstTwelve = Array.from(
			{ length: AUTHOR_COLOR_PALETTE.length },
			(_, index) => ensureAuthorColor(assignments, `author-${index}`).assignment.color,
		);

		expect(new Set(firstTwelve)).toEqual(new Set(AUTHOR_COLOR_PALETTE));
		expect(firstTwelve).toHaveLength(new Set(firstTwelve).size);
		expect(AUTHOR_COLOR_PALETTE).toContain(ensureAuthorColor(assignments, "author-12").assignment.color);
	});

	test("reserves a palette color used by a manual override", () => {
		const assignments: AuthorColorAssignments = {
			custom: { color: AUTHOR_COLOR_PALETTE[0], mode: "custom" },
		};

		expect(ensureAuthorColor(assignments, "generated").assignment.color).toBe(AUTHOR_COLOR_PALETTE[1]);
	});

	test("assigns colors to every existing discovered author while the feature is off", () => {
		const assignments: AuthorColorAssignments = {};

		expect(ensureAuthorColors(assignments, ["Carol", "Alice", "Bob"], new Set())).toBe(true);
		expect(Object.keys(assignments)).toEqual(["Alice", "Bob", "Carol"]);
		expect(new Set(Object.values(assignments).map(({ color }) => color)).size).toBe(3);
	});

	test("persists generated assignments and resets custom colors", () => {
		const assignments: AuthorColorAssignments = {};
		const original = ensureAuthorColor(assignments, "Kyle McDonald").assignment;
		const reloaded = hydrateAuthorColors(JSON.parse(JSON.stringify(assignments)));

		expect(ensureAuthorColor(reloaded, "Kyle McDonald")).toEqual({
			author: "Kyle_McDonald",
			assignment: original,
			created: false,
		});
		reloaded.Kyle_McDonald = { color: "#abcdef", mode: "custom" };
		expect(resetAuthorColor(reloaded, "Kyle McDonald").mode).toBe("generated");
	});

	test("normalizes valid stored colors and discards malformed assignments", () => {
		expect(
			hydrateAuthorColors({
				Alice: { color: "#AABBCC", mode: "custom" },
				Bob: { color: "blue", mode: "generated" },
				Carol: { color: "#123456", mode: "unknown" },
			}),
		).toEqual({ Alice: { color: "#aabbcc", mode: "custom" } });
	});

	test("hydrates a canonical, deduplicated author color opt-out list", () => {
		expect(hydrateExcludedAuthors([" Alice ", "Bob Smith", "Alice", 42, ""])).toEqual(["Alice", "Bob_Smith"]);
		expect(hydrateExcludedAuthors({ Alice: true })).toEqual([]);
	});

	test("reads a stored color without creating one", () => {
		const assignments: AuthorColorAssignments = { Alice: { color: "#0090ff", mode: "generated" } };

		expect(readAuthorColor(assignments, new Set(), "Alice", true)).toBe("#0090ff");
		// The read path runs on every render, so an unknown author must not be
		// silently assigned a color as a side effect of drawing them.
		expect(readAuthorColor(assignments, new Set(), "Bob", true)).toBeNull();
		expect(assignments.Bob).toBeUndefined();
	});

	test("returns no color when globally disabled or individually excluded", () => {
		const assignments: AuthorColorAssignments = {
			Alice: { color: "#0090ff", mode: "generated" },
			Bob: { color: "#e54d2e", mode: "custom" },
		};

		expect(readAuthorColor(assignments, new Set(), "Alice", false)).toBeNull();
		expect(readAuthorColor(assignments, new Set(["Bob"]), "Bob", true)).toBeNull();
		// Neither gate deletes the saved assignment.
		expect(assignments.Alice).toBeDefined();
		expect(assignments.Bob).toBeDefined();
	});

	test("restores the legacy yellow highlight only when author colors are globally disabled", () => {
		expect(effectiveHighlightColor("#0090ff", false)).toBe("#f2b90d");
		expect(effectiveHighlightColor(null, false)).toBe("#f2b90d");
		expect(effectiveHighlightColor(null, true)).toBeNull();
	});

	test("canonicalizes whitespace exactly like the stored by token", () => {
		expect(canonicalAuthorKey("  Kyle  McDonald\tJr. ")).toBe("Kyle_McDonald_Jr.");
	});

	test("indexes original creators, falls back for legacy comments, and excludes reply-only authors", () => {
		const doc = [
			"<!--co:a by:Alice status:open",
			"Alice: original",
			"Bob: reply",
			"-->",
			"<!--co:b status:open",
			"Legacy Author: original",
			"Carol: reply",
			"-->",
		].join("\n");

		expect(creatorsForComments(parseComments(doc))).toEqual(["Alice", "Legacy_Author"]);
	});

	test("indexes reply authors whose names are rendered on comment cards", () => {
		const doc = [
			"<!--co:a by:Alice status:open",
			"Alice: original",
			"Bob Smith: reply",
			"+👍 Reaction Only",
			"-->",
		].join("\n");

		expect(commentersForComments(parseComments(doc))).toEqual(["Alice", "Bob_Smith"]);
	});
});
