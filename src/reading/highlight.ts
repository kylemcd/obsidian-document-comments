import type { MarkdownPostProcessorContext } from "obsidian";
import { ParsedComment } from "../format/types";
import { anchorRange, fencedRanges, isHighlight, parseComments } from "../format/parse";
import { isCodeComment, resolveCodeAnchor } from "../format/code-anchor";
import { commentPreview } from "../format/preview";
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
		const color = colorForAuthor?.(author);
		// A code comment highlights its resolved target lines within this block's
		// <pre>. Each line is wrapped separately — a whole-line match sits in one
		// text node for plain code blocks (syntax-highlighted blocks split it across
		// token spans, where the wrap fails gracefully; a precise highlight there is
		// a follow-up using the CSS Custom Highlight path).
		if (isCodeComment(c)) {
			const target = resolveCodeAnchor(text, c);
			if (!target || target.from < sectionFrom || target.from >= sectionTo) continue;
			for (const lineText of text.slice(target.from, target.to).split("\n")) {
				if (lineText.trim()) {
					wrapFirstMatch(el, lineText, c.id, c.status === "resolved", commentPreview(c), author, color);
				}
			}
			continue;
		}
		const range = anchorRange(c);
		if (!range) continue;
		// Only act on comments whose anchor starts within this rendered section.
		if (range.from < sectionFrom || range.from >= sectionTo) continue;
		const quote = text.slice(range.from, range.to);
		if (!quote.trim()) continue;
		const preview = commentPreview(c);
		const codeText = inlineCodeText(quote);
		if (codeText !== null) {
			const code = inlineCodeElement(el, sectionSource, range.from - sectionFrom, codeText);
			if (code) wrapFirstMatch(code, codeText, c.id, c.status === "resolved", preview, author, color);
			continue;
		}
		wrapFirstMatch(el, quote, c.id, c.status === "resolved", preview, author, color);
	}
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
const wrapFirstMatch = (
	root: HTMLElement,
	needle: string,
	id: string,
	resolved: boolean,
	title: string | null,
	author: string,
	color: ResolvedAuthorColor | undefined,
): boolean => {
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	while (node) {
		const idx = node.data.indexOf(needle);
		if (idx >= 0 && !isInsideHighlight(node)) {
			const range = doc.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + needle.length);
			const span = root.createSpan({
				cls: resolved ? "doc-comment-span is-resolved" : "doc-comment-span",
			});
			span.detach();
			span.setAttribute("data-cid", id);
			span.setAttribute("data-dc-author", author);
			if (color !== undefined) span.style.setProperty("--dc-highlight-color", authorColorCss(color));
			if (title) span.setAttribute("title", title);
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
