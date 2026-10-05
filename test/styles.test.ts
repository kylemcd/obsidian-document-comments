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

/** The rules inside every `@media <query>` block. Only plain rules nest in one, so a
 *  single level of braces covers every block in the stylesheet. */
const mediaBlocks = (query: string): string[] => {
	const escaped = query.replace(/[()]/g, "\\$&");
	const block = new RegExp(`@media ${escaped}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`, "g");
	return Array.from(styles.matchAll(block), (match) => match[1] ?? "");
};

describe("entry action bar on touch screens", () => {
	// iOS treats a tap that reveals buttons through :hover as a hover and never sends
	// the mousedown and click, so a hover-revealed bar made a card's first tap do
	// nothing but show the bar (#85).
	const hoverReveal = /\.dc-entry:hover \.dc-entry__bar\s*\{[^}]*opacity: 1/;

	test("reveals the bar on hover only where the pointer can hover", () => {
		const outside = mediaBlocks("(hover: hover)").reduce((css, block) => css.replace(block, ""), styles);

		expect(mediaBlocks("(hover: hover)").some((block) => hoverReveal.test(block))).toBe(true);
		expect(outside).not.toMatch(hoverReveal);
	});

	test("shows the bar on an open or edited card on touch screens, where there is no hover", () => {
		// An empty comment's card is edited, not opened, when pressed.
		const touchBar =
			/\.doc-comment-card\.is-open \.dc-entry__bar,\s*\.doc-comment-card\.is-editing \.dc-entry__bar\s*\{([^}]*)\}/;
		const rule =
			mediaBlocks("(hover: none)")
				.map((block) => touchBar.exec(block)?.[1])
				.find((body) => body !== undefined) ?? "";

		expect(rule).toContain("opacity: 1");
		expect(rule).toContain("pointer-events: auto");
	});
});

describe("narrow panes", () => {
	// Giving the column its full width at any pane width squeezed the text to a
	// sliver on a narrow pane, which pushed every anchor, and its card, out of view (#83).
	const textWidth =
		/max-width: min\(\s*var\(--file-line-width, 50rem\),\s*max\(var\(--dc-min-text-width\), calc\(100% - var\(--dc-margin-width\)\)\)\s*\)/;

	test("keeps the Live Preview text at its minimum width beside the column", () => {
		const rule =
			/\.markdown-source-view\.mod-cm6 \.cm-editor\.dc-has \.cm-sizer\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";

		expect(rule).toMatch(textWidth);
	});

	test("keeps the Reading view text at its minimum width beside the column", () => {
		const rule =
			/\.markdown-reading-view\.dc-has \.markdown-preview-view \.markdown-preview-sizer\s*\{([^}]*)\}/.exec(
				styles,
			)?.[1] ?? "";

		expect(rule).toMatch(textWidth);
	});

	test("defines the minimum text width", () => {
		expect(styles).toMatch(/--dc-min-text-width: \d+rem;/);
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
