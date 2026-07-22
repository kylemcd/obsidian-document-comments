import type { MarkdownPostProcessorContext } from "obsidian";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";
import { isCodeComment, resolveCodeAnchor } from "../format/code-anchor";
import { commentPreview } from "../format/preview";

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
	sectionRanges.set(el, {
		from: sectionFrom,
		source: text.slice(sectionFrom, sectionTo),
		sourcePath: ctx.sourcePath,
	});

	const comments = commentsFor(text);
	if (comments.length === 0) return;

	for (const c of comments) {
		// A code comment highlights its resolved target lines within this block's
		// <pre>. Each line is wrapped separately — a whole-line match sits in one
		// text node for plain code blocks (syntax-highlighted blocks split it across
		// token spans, where the wrap fails gracefully; a precise highlight there is
		// a follow-up using the CSS Custom Highlight path).
		if (isCodeComment(c)) {
			const target = resolveCodeAnchor(text, c);
			if (!target || target.from < sectionFrom || target.from >= sectionTo) continue;
			for (const lineText of text.slice(target.from, target.to).split("\n")) {
				if (lineText.trim()) wrapFirstMatch(el, lineText, c.id, c.status === "resolved", commentPreview(c));
			}
			continue;
		}
		const range = anchorRange(c);
		if (!range) continue;
		// Only act on comments whose anchor starts within this rendered section.
		if (range.from < sectionFrom || range.from >= sectionTo) continue;
		const quote = text.slice(range.from, range.to);
		if (quote.trim()) wrapFirstMatch(el, quote, c.id, c.status === "resolved", commentPreview(c));
	}
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
