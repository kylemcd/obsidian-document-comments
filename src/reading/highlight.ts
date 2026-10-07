import type { MarkdownPostProcessorContext } from "obsidian";
import { ParsedComment } from "../format/types";
import { anchorRange, fencedRanges, isHighlight, parseComments } from "../format/parse";
import { isCodeComment, resolveCodeAnchor } from "../format/code-anchor";
import { commentPreview } from "../format/preview";
import { MARKER_GUARD, isStructuralLine, leadingMarkup } from "../format/line-start";
import { sourceLines, sourceTables, unescapedPipes } from "../format/table";
import { spanSelector } from "../util/css";
import {
	authorColorCss,
	creatorForComment,
	type AuthorColorResolver,
	type ResolvedAuthorColor,
} from "../author-colors";

export type SectionRange = {
	from: number;
	source: string;
	/** The file this rendered block came from — an embed/preview renders another
	 *  file's blocks, and a selection there must NOT be written into the host. */
	sourcePath: string;
};

/** Rendered block element → its source range, so a Reading-view selection can be
 *  mapped back to markdown offsets (best-effort, used by "Add comment"). */
const sectionRanges = new WeakMap<HTMLElement, SectionRange>();

/** Walk up from a DOM node to the nearest rendered block we have source for. */
export const findSectionRange = (node: Node): SectionRange | null => {
	let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
	while (el) {
		const range = sectionRanges.get(el);
		if (range) return range;
		el = el.parentElement;
	}
	return null;
};

export type SourceSelection = {
	from: number;
	to: number;
	expected: string;
};

/** Map a rendered selection back to source without discarding boundary spaces.
 *  An exact existing highlight carries its source identity in `data-cid`, which
 *  also disambiguates repeated rendered text. */
export const mapReadingSelection = (
	selection: Selection,
	section: SectionRange,
	doc: string,
): SourceSelection | null => {
	const selected = selection.toString();
	if (!selected.trim()) return null;

	const highlighted = selectedHighlightRange(selection, selected, doc);
	if (highlighted) return highlighted;

	const idx = section.source.indexOf(selected);
	if (idx < 0) return null;
	return {
		from: section.from + idx,
		to: section.from + idx + selected.length,
		expected: selected,
	};
};

// Parsing the whole file per rendered block would be wasteful, so cache the last
// parse keyed on the exact source text.
let cacheKey: string | null = null;
let cacheVal: ParsedComment[] = [];

const commentsFor = (text: string): ParsedComment[] => {
	if (text !== cacheKey) {
		cacheKey = text;
		cacheVal = parseComments(text);
	}
	return cacheVal;
};

/**
 * Reading-view post-processor: wraps each comment's anchored text in a
 * `.doc-comment-span[data-cid]` so the highlight shows in rendered output.
 * The `<!--c:-->` / `<!--co:-->` markers are HTML comments, already invisible.
 */
export const highlightPostProcessor = (
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	colorForAuthor?: AuthorColorResolver,
	currentAuthor = "me",
): void => {
	const info = ctx.getSectionInfo(el);
	if (!info) return;
	const { text, lineStart, lineEnd } = info;

	const lines = text.split("\n");
	const sectionFrom = offsetOfLine(lines, lineStart);
	const sectionTo = offsetOfLine(lines, lineEnd + 1);
	const sectionSource = text.slice(sectionFrom, sectionTo);
	// Remember this block's source range for selection → markdown mapping.
	sectionRanges.set(el, {
		from: sectionFrom,
		source: sectionSource,
		sourcePath: ctx.sourcePath,
	});

	const comments = commentsFor(text);
	if (comments.length === 0) return;

	for (const c of comments) {
		const author = creatorForComment(c) ?? currentAuthor;
		const attrs: HighlightAttrs = {
			id: c.id,
			resolved: c.status === "resolved",
			title: commentPreview(c),
			author,
			color: colorForAuthor?.(author),
		};
		// A code comment highlights its resolved target lines within this block's
		// <pre>, across the token spans a syntax-highlighted block splits them into.
		if (isCodeComment(c)) {
			const target = resolveCodeAnchor(text, c);
			if (!target || target.from < sectionFrom || target.from >= sectionTo) continue;
			const wrap = (): void => {
				if (wrapSourceRange(el, sectionSource, target.from - sectionFrom, target.to - sectionFrom, attrs))
					return;
				for (const lineText of text.slice(target.from, target.to).split("\n")) {
					if (lineText.trim()) wrapFirstMatch(el, lineText, attrs);
				}
			};
			wrap();
			keepAfterHighlighting(el, c.id, wrap);
			continue;
		}
		const range = anchorRange(c);
		if (!range) continue;
		// A comment can run over several rendered blocks, and each highlights its part.
		const from = Math.max(range.from, sectionFrom);
		const to = Math.min(range.to, sectionTo);
		if (from >= to) continue;
		const quote = text.slice(range.from, range.to);
		if (!quote.trim()) continue;
		const whole = range.from >= sectionFrom && range.to <= sectionTo;
		const codeText = whole ? inlineCodeText(quote) : null;
		if (codeText !== null) {
			const code = inlineCodeElement(el, sectionSource, range.from - sectionFrom, codeText);
			if (code) wrapFirstMatch(code, codeText, attrs);
			continue;
		}
		if (wrapSourceRange(el, sectionSource, from - sectionFrom, to - sectionFrom, attrs)) continue;
		if (whole) wrapFirstMatch(el, quote, attrs);
	}
};

/**
 * Wrap a code comment's lines again once syntax highlighting has run. Obsidian
 * fills a highlighted code block in after the post-processors, replacing the
 * block's contents and every span wrapped there. Checked in the app, it does so
 * once or twice right after rendering, so a few re-wraps over a few seconds cover it.
 */
const keepAfterHighlighting = (el: HTMLElement, id: string, wrap: () => void): void => {
	const view = el.ownerDocument.defaultView;
	if (!view || !el.querySelector("code")) return;
	let rewraps = 3;
	const observer = new view.MutationObserver(() => {
		if (el.querySelector(spanSelector(id))) return;
		observer.disconnect();
		wrap();
		rewraps -= 1;
		if (rewraps > 0) observer.observe(el, { childList: true, subtree: true });
	});
	observer.observe(el, { childList: true, subtree: true });
	view.setTimeout(() => observer.disconnect(), 5000);
};

type HighlightAttrs = {
	id: string;
	resolved: boolean;
	title: string | null;
	author: string;
	color: ResolvedAuthorColor | undefined;
};

type Visible = {
	text: string;
	/** Where each source offset lands in `text`, with one more entry for the end. */
	at: number[];
};

const ENTITIES: Record<string, number> = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160 };

/**
 * The text Reading view shows for a stretch of Markdown source, and where each
 * source offset lands in it.
 *
 * It drops what renders as nothing: comments, block markup, fence and rule lines,
 * code-span backticks, emphasis and highlight delimiters, link and wikilink
 * syntax, escapes, and table pipes. It's approximate, but close enough to find a
 * comment's text in the rendered block when that text carries formatting, which
 * matching the raw source never could.
 */
export const visibleText = (source: string): Visible => {
	const shown = source.split("");
	const fixed = Array.from({ length: source.length }, () => false);
	const hide = (from: number, to: number): void => {
		shown.fill("", from, to);
	};
	const settle = (from: number, to: number): void => void fixed.fill(true, from, to);
	const free = (from: number, to: number): boolean => !fixed.slice(from, to).includes(true);
	const each = (pattern: RegExp, apply: (match: RegExpExecArray, from: number) => void): void => {
		for (const match of source.matchAll(pattern)) {
			if (free(match.index, match.index + match[0].length)) apply(match, match.index);
		}
	};

	// Comments render as nothing, and code shows as written.
	[
		...htmlCommentRanges(source),
		...[...source.matchAll(/%%[\s\S]*?%%/g)].map((m): [number, number] => [m.index, m.index + m[0].length]),
	].forEach(([from, to]) => {
		hide(from, to);
		settle(from, to);
	});
	const fences = fencedRanges(source);
	fences.forEach(([from, to]) => settle(from, to));
	inlineCodeSpans(source).forEach((span) => {
		const ticks = backtickRun(source, span.from);
		settle(span.from, span.to);
		hide(span.from, span.from + ticks);
		hide(span.to - ticks, span.to);
	});

	const lines = sourceLines(source);
	const tables = sourceTables(lines);
	lines.forEach((line, index) => {
		const fence = fences.find(([from, to]) => line.from >= from && line.from <= to);
		if (fence) {
			if (line.from === fence[0] || line.to === fence[1]) hide(line.from, line.to);
			return;
		}
		const table = tables.find((candidate) => index >= candidate.start && index < candidate.end);
		if (table) {
			if (index === table.start + 1) hide(line.from, line.to);
			else unescapedPipes(line.text).forEach((pipe) => hide(line.from + pipe, line.from + pipe + 1));
			return;
		}
		if (isStructuralLine(line.text)) {
			hide(line.from, line.to);
			return;
		}
		hide(line.from, line.from + leadingMarkup(line.text).end);
		const blockId = /\s\^[A-Za-z0-9-]+\s*$/.exec(line.text);
		if (blockId) hide(line.from + blockId.index, line.to);
	});

	// Embedded notes and images show no text of their own in this block.
	each(/!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g, (match, from) => hide(from, from + match[0].length));
	// A wikilink shows its alias, or else its target.
	each(/\[\[([^\]|\n]*)(\|[^\]\n]*)?\]\]/g, (match, from) => {
		hide(from, from + 2 + (match[2] ? (match[1]?.length ?? 0) + 1 : 0));
		hide(from + match[0].length - 2, from + match[0].length);
	});
	// A link shows its text, and a footnote reference `[^1]` shows `[1]`.
	each(/\[([^\]\n]*)\]\([^)\n]*\)/g, (match, from) => {
		hide(from, from + 1);
		hide(from + 1 + (match[1]?.length ?? 0), from + match[0].length);
	});
	each(/\[\^[^\]\n]+\]/g, (_match, from) => hide(from + 1, from + 2));
	each(/<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^@<>\s]+@[^@<>\s]+)>/g, (match, from) => {
		hide(from, from + 1);
		hide(from + match[0].length - 1, from + match[0].length);
		settle(from, from + match[0].length);
	});
	rawHtmlTags(source)
		.filter((tag) => free(tag.from, tag.to))
		.forEach((tag) => hide(tag.from, tag.to));
	each(/\\[!-/:-@[-`{-~]/g, (_match, from) => hide(from, from + 1));
	each(/([*_=~])\1*/g, (match, from) => {
		if (isDelimiter(source, match[0], from)) hide(from, from + match[0].length);
	});
	each(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (match, from) => {
		const code = match[1] ? Number(match[1]) : match[2] ? parseInt(match[2], 16) : ENTITIES[match[3] ?? ""];
		if (code === undefined || code > 0x10ffff) return;
		hide(from, from + match[0].length);
		shown[from] = String.fromCodePoint(code);
	});

	const at: number[] = [];
	const text = shown.reduce((built, piece) => {
		at.push(built.length);
		return built + piece;
	}, "");
	at.push(text.length);
	return { text, at };
};

/** Whether a run of `*`, `_`, `=`, or `~` is emphasis, highlight, or strikethrough
 *  markup rather than text: it touches a word on one side, and an `_` isn't inside
 *  one. Only `==` and `~~` count for the last two. */
const isDelimiter = (source: string, run: string, from: number): boolean => {
	if (isEscaped(source, from)) return false;
	const before = source.charAt(from - 1);
	const after = source.charAt(from + run.length);
	const opens = after !== "" && !/\s/.test(after);
	const closes = before !== "" && !/\s/.test(before);
	if (!opens && !closes) return false;
	const char = run.charAt(0);
	if (char === "=" || char === "~") return run.length === 2;
	if (char === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
	return run.length <= 3;
};

type Folded = {
	text: string;
	/** For each folded character, the offset it came from. */
	from: number[];
	/** Where each offset lands in the folded text, with one more entry for the end. */
	at: number[];
};

/** `text` with every run of whitespace folded to one space and guards dropped, so
 *  the source and the rendered block compare without regard to line breaks. */
const fold = (text: string): Folded => {
	const from: number[] = [];
	const at: number[] = [];
	let folded = "";
	// Builds three outputs in one pass, which no single array method does.
	for (let i = 0; i < text.length; i++) {
		at.push(folded.length);
		const char = text.charAt(i);
		const space = /\s/.test(char);
		if (char === MARKER_GUARD || (space && folded.endsWith(" "))) continue;
		folded += space ? " " : char;
		from.push(i);
	}
	at.push(folded.length);
	return { text: folded, from, at };
};

// Rendered UI that isn't the note's text, and embeds, whose text is another note's.
const NOT_TEXT =
	".list-bullet, .collapse-indicator, .footnote-backref, .copy-code-button, .callout-icon, .callout-fold, " +
	".internal-embed, .markdown-embed, .frontmatter, .metadata-container, mjx-container, .math, svg, button, input";

type Rendered = { text: string; nodes: Array<{ node: Text; from: number }> };

/** The text nodes of a rendered block, in order, joined. */
const renderedText = (root: HTMLElement): Rendered => {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Rendered["nodes"] = [];
	let text = "";
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!isText(node) || insideNotText(node, root)) continue;
		nodes.push({ node, from: text.length });
		text += node.data;
	}
	return { text, nodes };
};

const isText = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;

const insideNotText = (node: Node, root: HTMLElement): boolean => {
	for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
		if (el.matches(NOT_TEXT)) return true;
	}
	return false;
};

/**
 * Highlight the rendered text of `source.slice(from, to)` in `root`, across as
 * many elements as it spans. Of several matches, the one nearest the source's own
 * position wins, so a repeated phrase highlights where the comment is. False when
 * the text can't be found, so the caller can fall back to an exact match.
 */
const wrapSourceRange = (
	root: HTMLElement,
	source: string,
	from: number,
	to: number,
	attrs: HighlightAttrs,
): boolean => {
	const visible = visibleText(source);
	const shown = fold(visible.text);
	const start = shown.at[visible.at[from] ?? 0] ?? 0;
	const span = shown.text.slice(start, shown.at[visible.at[to] ?? 0] ?? 0);
	const rendered = renderedText(root);
	const page = fold(rendered.text);
	// The exact text first, boundary spaces and all, then trimmed for when the
	// edges of the block drop them.
	const lead = span.length - span.trimStart().length;
	const tries = [
		{ needle: span, hint: start },
		{ needle: span.trim(), hint: start + lead },
	];
	return tries.some(({ needle, hint }) => {
		if (!needle.trim()) return false;
		const found = nearest(page.text, needle, hint);
		const first = page.from[found];
		const last = page.from[found + needle.length - 1];
		if (found < 0 || first === undefined || last === undefined) return false;
		wrapRendered(root, rendered, first, last + 1, attrs);
		return true;
	});
};

/** The occurrence of `needle` in `text` nearest offset `hint`, or -1. */
const nearest = (text: string, needle: string, hint: number): number => {
	let found = -1;
	// Every occurrence has to be weighed, which indexOf only gives one at a time.
	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
		if (found < 0 || Math.abs(at - hint) < Math.abs(found - hint)) found = at;
	}
	return found;
};

const BLOCK_TAGS = new Set(["UL", "OL", "LI", "P", "TABLE", "THEAD", "TBODY", "TR", "BLOCKQUOTE", "DIV", "PRE", "HR"]);
const CONTAINER_TAGS = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "BLOCKQUOTE", "DIV", "SECTION"]);

/** Wrap rendered text `[from, to)` piece by piece, one span per text node it covers. */
const wrapRendered = (root: HTMLElement, rendered: Rendered, from: number, to: number, attrs: HighlightAttrs): void => {
	rendered.nodes
		.filter(({ node, from: at }) => at < to && at + node.length > from)
		.forEach(({ node, from: at }) => {
			const end = Math.min(to, at + node.length) - at;
			const start = Math.max(from, at) - at;
			if (end < node.length) node.splitText(end);
			const piece = start > 0 ? node.splitText(start) : node;
			// The line breaks between list items or table cells aren't the note's text,
			// and a span there would sit where only block elements belong.
			if (!piece.data.trim() && betweenBlocks(piece)) return;
			const highlight = highlightSpan(root, attrs);
			piece.parentNode?.insertBefore(highlight, piece);
			highlight.appendChild(piece);
		});
};

const betweenBlocks = (node: Text): boolean => {
	const parent = node.parentElement;
	if (parent && CONTAINER_TAGS.has(parent.tagName)) return true;
	return [node.previousSibling, node.nextSibling].some(
		(sibling) => sibling?.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((sibling as Element).tagName),
	);
};

const highlightSpan = (root: HTMLElement, attrs: HighlightAttrs): HTMLElement => {
	const span = root.createSpan({ cls: attrs.resolved ? "doc-comment-span is-resolved" : "doc-comment-span" });
	span.detach();
	span.setAttribute("data-cid", attrs.id);
	span.setAttribute("data-dc-author", attrs.author);
	if (attrs.color !== undefined) span.style.setProperty("--dc-highlight-color", authorColorCss(attrs.color));
	if (attrs.title) span.setAttribute("title", attrs.title);
	return span;
};

/** Convert one complete Markdown code span to the text that Reading view renders. */
const inlineCodeText = (source: string): string | null => {
	const delimiter = /^`+/.exec(source)?.[0];
	if (!delimiter || source.length <= delimiter.length * 2 || !source.endsWith(delimiter)) return null;
	let content = source.slice(delimiter.length, -delimiter.length).replace(/\r?\n/g, " ");
	// A matching delimiter inside the content means this is not one complete span.
	if ([...content.matchAll(/`+/g)].some((match) => match[0].length === delimiter.length)) return null;
	// CommonMark removes one boundary space when the content is not all spaces.
	if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
	return content;
};

type InlineCodeSpan = { from: number; to: number; text: string };

/** Match a source code span to the same occurrence in rendered DOM. */
const inlineCodeElement = (
	root: HTMLElement,
	sectionSource: string,
	targetFrom: number,
	targetText: string,
): HTMLElement | null => {
	const spans = inlineCodeSpans(sectionSource);
	const sourceCodeOffsets = [...spans.map((span) => span.from), ...rawInlineCodeOffsets(sectionSource, spans)].sort(
		(a, b) => a - b,
	);
	const occurrence = sourceCodeOffsets.filter((offset) => offset < targetFrom).length;
	const codes = [...root.querySelectorAll<HTMLElement>("code")].filter((code) => !code.closest("pre"));
	const code = codes[occurrence] ?? null;
	return code?.textContent === targetText ? code : null;
};

/** Find rendered Markdown code spans while preserving their source offsets. */
const inlineCodeSpans = (source: string): InlineCodeSpan[] => {
	const spans: InlineCodeSpan[] = [];
	const masked = [
		...fencedRanges(source),
		...htmlCommentRanges(source),
		...rawHtmlTags(source).map((tag): [number, number] => [tag.from, tag.to]),
	];
	let cursor = 0;

	while (cursor < source.length) {
		const open = source.indexOf("`", cursor);
		if (open < 0) break;
		const openLength = backtickRun(source, open);
		if (isMasked(masked, open) || isEscaped(source, open)) {
			cursor = open + openLength;
			continue;
		}

		let closeCursor = open + openLength;
		let found = false;
		while (closeCursor < source.length) {
			const close = source.indexOf("`", closeCursor);
			if (close < 0) break;
			const closeLength = backtickRun(source, close);
			if (closeLength === openLength) {
				const end = close + closeLength;
				const text = inlineCodeText(source.slice(open, end));
				if (text !== null) spans.push({ from: open, to: end, text });
				cursor = end;
				found = true;
				break;
			}
			closeCursor = close + closeLength;
		}
		if (!found) cursor = open + openLength;
	}

	return spans;
};

/** Find raw inline `<code>` elements because they share the rendered DOM list
 *  with Markdown code spans. Raw code inside `<pre>` is excluded on both sides. */
const rawInlineCodeOffsets = (source: string, spans: InlineCodeSpan[]): number[] => {
	const offsets: number[] = [];
	const masked: Array<[number, number]> = [
		...fencedRanges(source),
		...spans.map((span): [number, number] => [span.from, span.to]),
		...htmlCommentRanges(source),
	];
	let preDepth = 0;

	for (const tag of rawHtmlTags(source)) {
		if (isMasked(masked, tag.from)) continue;
		if (tag.name === "pre") {
			if (tag.closing) preDepth = Math.max(0, preDepth - 1);
			else if (!tag.selfClosing) preDepth++;
		} else if (tag.name === "code" && !tag.closing && preDepth === 0) {
			offsets.push(tag.from);
		}
	}

	return offsets;
};

type RawHtmlTag = {
	from: number;
	to: number;
	name: string;
	closing: boolean;
	selfClosing: boolean;
};

/** Locate raw HTML tags and keep quoted `>` characters inside the tag range. */
const rawHtmlTags = (source: string): RawHtmlTag[] => {
	const tags: RawHtmlTag[] = [];
	let cursor = 0;

	while (cursor < source.length) {
		const from = source.indexOf("<", cursor);
		if (from < 0) break;
		if (isEscaped(source, from)) {
			cursor = from + 1;
			continue;
		}
		let position = from + 1;
		const closing = source.charAt(position) === "/";
		if (closing) position++;
		if (!/[A-Za-z]/.test(source.charAt(position))) {
			cursor = from + 1;
			continue;
		}
		const nameFrom = position;
		while (/[A-Za-z0-9:-]/.test(source.charAt(position))) position++;
		const nameTo = position;
		if (position < source.length && !/[\s/>]/.test(source.charAt(position))) {
			cursor = from + 1;
			continue;
		}

		let quote = "";
		let to = -1;
		for (; position < source.length; position++) {
			const char = source.charAt(position);
			if (quote) {
				if (char === quote) quote = "";
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (char === ">") {
				to = position + 1;
				break;
			}
		}
		if (to < 0) {
			cursor = from + 1;
			continue;
		}
		const raw = source.slice(from, to);
		tags.push({
			from,
			to,
			name: source.slice(nameFrom, nameTo).toLowerCase(),
			closing,
			selfClosing: /\/\s*>$/.test(raw),
		});
		cursor = to;
	}

	return tags;
};

const htmlCommentRanges = (source: string): Array<[number, number]> => {
	return [...source.matchAll(/<!--[\s\S]*?-->/g)].flatMap((match): Array<[number, number]> =>
		match.index === undefined ? [] : [[match.index, match.index + match[0].length]],
	);
};

const backtickRun = (source: string, from: number): number => {
	let to = from;
	while (source.charAt(to) === "`") to++;
	return to - from;
};

const isEscaped = (source: string, position: number): boolean => {
	let slashes = 0;
	for (let cursor = position - 1; cursor >= 0 && source.charAt(cursor) === "\\"; cursor--) slashes++;
	return slashes % 2 === 1;
};

const isMasked = (ranges: Array<[number, number]>, position: number): boolean => {
	return ranges.some(([from, to]) => position >= from && position < to);
};

const selectedHighlightRange = (selection: Selection, selected: string, doc: string): SourceSelection | null => {
	const anchor = closestHighlight(selection.anchorNode);
	const focus = closestHighlight(selection.focusNode);
	if (!anchor || anchor !== focus || selected !== anchor.textContent) return null;
	const id = anchor.dataset.cid;
	if (!id) return null;
	const comment = parseComments(doc).find((candidate) => candidate.id === id && isHighlight(candidate));
	if (!comment) return null;
	const range = isCodeComment(comment) ? resolveCodeAnchor(doc, comment) : anchorRange(comment);
	if (!range) return null;
	return { ...range, expected: doc.slice(range.from, range.to) };
};

const closestHighlight = (node: Node | null): HTMLElement | null => {
	if (!node) return null;
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
	return el?.closest<HTMLElement>(".doc-comment-span[data-cid]") ?? null;
};

const offsetOfLine = (lines: string[], lineNo: number): number => {
	return lines.slice(0, lineNo).reduce((offset, line) => offset + line.length + 1, 0);
};

/** Wrap the first single-text-node occurrence of `needle` in a highlight span.
 *  Uses the element's own document so it works in pop-out windows too. */
const wrapFirstMatch = (root: HTMLElement, needle: string, attrs: HighlightAttrs): boolean => {
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	while (node) {
		const idx = node.data.indexOf(needle);
		if (idx >= 0 && !isInsideHighlight(node)) {
			const range = doc.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + needle.length);
			const span = highlightSpan(root, attrs);
			try {
				range.surroundContents(span);
				return true;
			} catch {
				return false; // range crossed element boundaries — skip gracefully
			}
		}
		node = walker.nextNode() as Text | null;
	}
	return false;
};

const isInsideHighlight = (node: Node): boolean => {
	return !!(node.parentElement && node.parentElement.closest(".doc-comment-span"));
};
