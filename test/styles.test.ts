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
