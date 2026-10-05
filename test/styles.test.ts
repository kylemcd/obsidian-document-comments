import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("per-author highlight styles", () => {
	test("uses the theme text color when no author mapping is active", () => {
		expect(styles).toMatch(/--dc-highlight-color: var\(--text-normal\)/);
	});

	test("derives colors on each span so its local author variable wins the cascade", () => {
		const rule = /\.doc-comment-span\s*\{([\s\S]*?)\}/.exec(styles)?.[1] ?? "";

		expect(rule).toContain("--dc-highlight-bg: color-mix(in srgb, var(--dc-highlight-color) 18%");
		expect(rule).toContain("--dc-highlight-bg-active: color-mix(in srgb, var(--dc-highlight-color) 38%");
		expect(rule).toContain("--dc-highlight-border: color-mix(in srgb, var(--dc-highlight-color) 70%");
	});

	test("keeps resolved and draft treatments tied to the author color", () => {
		expect(styles).toMatch(
			/\.doc-comment-span\.is-resolved\s*\{[\s\S]*?border-bottom: 1px dashed var\(--dc-highlight-border\)/,
		);
		expect(styles).toMatch(
			/\.doc-comment-span\.dc-draft\s*\{[\s\S]*?border-bottom-color: var\(--dc-highlight-border\)/,
		);
		expect(styles).toMatch(
			/\.doc-comment-span\.dc-draft\s*\{[\s\S]*?--dc-highlight-color: var\(--dc-draft-highlight-color/,
		);
	});

	test("mixes author names with the theme text color for readable contrast", () => {
		expect(styles).toMatch(
			/\.dc-entry__author\s*\{[\s\S]*?color: color-mix\(in srgb, var\(--dc-author-color, var\(--text-normal\)\) 40%, var\(--text-normal\)\)/,
		);
	});

	test("uses deeper author colors in dark themes", () => {
		expect(styles).toMatch(
			/\.theme-dark \.dc-entry__author\s*\{[\s\S]*?color: color-mix\(in srgb, var\(--dc-author-color, var\(--text-normal\)\) 70%, var\(--text-normal\)\)/,
		);
	});

	test("centers and tightens only author color setting rows", () => {
		const rule = /\.dc-author-color-setting\s*\{([\s\S]*?)\}/.exec(styles)?.[1] ?? "";

		expect(rule).toContain("align-items: center");
		expect(rule).toContain("padding-block: 10px");
	});
});

describe("comment text selection", () => {
	// Obsidian sets `user-select: none` on body and turns it back on only for note
	// content, so a card's text can't be selected unless the card opts in (#80).
	const openCardText = /\.doc-comment-card\.is-open \.dc-entry__text:not\(\.dc-entry__text--empty\)\s*\{([\s\S]*?)\}/;

	test("lets an open card's text be selected, including on iOS", () => {
		const rule = openCardText.exec(styles)?.[1] ?? "";

		expect(rule).toContain("user-select: text");
		expect(rule).toContain("-webkit-user-select: text");
	});

	test("keeps a closed card's text out of a drag that starts in the note", () => {
		// Reading view puts the margin after the note, so selectable text on every
		// card would pull all the paragraphs in between into an overshooting drag.
		const rule = /\.dc-entry__text\s*\{([\s\S]*?)\}/.exec(styles)?.[1] ?? "";

		expect(rule).not.toContain("user-select");
	});
});
