import { MarkdownPostProcessorContext } from "obsidian";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";
import { commentPreview } from "../format/preview";

/** Rendered block element → its source range, so a Reading-view selection can be
 *  mapped back to markdown offsets (best-effort, used by "Add comment"). */
const sectionRanges = new WeakMap<HTMLElement, { from: number; source: string }>();

/** Walk up from a DOM node to the nearest rendered block we have source for. */
export const findSectionRange = (node: Node): { from: number; source: string } | null => {
	let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
	while (el) {
		const range = sectionRanges.get(el);
		if (range) return range;
		el = el.parentElement;
	}
	return null;
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
export const highlightPostProcessor = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
	const info = ctx.getSectionInfo(el);
	if (!info) return;
	const { text, lineStart, lineEnd } = info;

	const lines = text.split("\n");
	const sectionFrom = offsetOfLine(lines, lineStart);
	const sectionTo = offsetOfLine(lines, lineEnd + 1);
	// Remember this block's source range for selection → markdown mapping.
	sectionRanges.set(el, { from: sectionFrom, source: text.slice(sectionFrom, sectionTo) });

	const comments = commentsFor(text);
	if (comments.length === 0) return;

	for (const c of comments) {
		const range = anchorRange(c);
		if (!range) continue;
		// Only act on comments whose anchor starts within this rendered section.
		if (range.from < sectionFrom || range.from >= sectionTo) continue;
		const quote = text.slice(range.from, range.to);
		if (quote.trim()) wrapFirstMatch(el, quote, c.id, c.status === "resolved", commentPreview(c));
	}
};

const offsetOfLine = (lines: string[], lineNo: number): number => {
	let offset = 0;
	for (let i = 0; i < lineNo && i < lines.length; i++) offset += lines[i].length + 1;
	return offset;
};

/** Wrap the first single-text-node occurrence of `needle` in a highlight span.
 *  Uses the element's own document so it works in pop-out windows too. */
const wrapFirstMatch = (
	root: HTMLElement,
	needle: string,
	id: string,
	resolved: boolean,
	title: string | null,
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
			const span = doc.createElement("span");
			span.className = resolved ? "doc-comment-span is-resolved" : "doc-comment-span";
			span.setAttribute("data-cid", id);
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
