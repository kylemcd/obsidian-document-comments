import { ParsedComment, TextRange } from "./types";
import { anchorRange, fencedRanges } from "./parse";

type ContentLine = { text: string; from: number; to: number };

export type FenceStructure = {
	/** Offset of the opening fence line start. */
	fenceStart: number;
	/** Offset of the end of the closing fence line (before its trailing newline). */
	fenceEnd: number;
	/** The code lines between the fences, with absolute document offsets. */
	lines: ContentLine[];
};

/** Build the content-line structure of a fenced block from its [start,end] range. */
const fenceStructure = (doc: string, fenceStart: number, fenceEnd: number): FenceStructure => {
	const openLineEnd = doc.indexOf("\n", fenceStart);
	if (openLineEnd < 0 || openLineEnd >= fenceEnd) return { fenceStart, fenceEnd, lines: [] };
	const contentStart = openLineEnd + 1;
	const closingLineStart = doc.lastIndexOf("\n", fenceEnd - 1) + 1;
	const contentEnd = closingLineStart - 1; // the newline just before the closing fence
	if (contentEnd <= contentStart) return { fenceStart, fenceEnd, lines: [] };

	const lines: ContentLine[] = [];
	let cursor = contentStart;
	for (const text of doc.slice(contentStart, contentEnd).split("\n")) {
		lines.push({ text, from: cursor, to: cursor + text.length });
		cursor += text.length + 1;
	}
	return { fenceStart, fenceEnd, lines };
};

/** The fenced block containing `pos`, or null when `pos` is outside every fence. */
export const enclosingFence = (doc: string, pos: number): FenceStructure | null => {
	const range = fencedRanges(doc).find(([fs, fe]) => pos >= fs && pos < fe);
	return range ? fenceStructure(doc, range[0], range[1]) : null;
};

export type CodeSelection = {
	fenceStart: number;
	fenceEnd: number;
	quote: string;
	codeLines: TextRange;
};

/** Snap a selection inside a fence to the whole content lines it touches, and
 *  return the block bounds plus the quoted code and its block-relative line range. */
export const codeSelectionTarget = (doc: string, from: number, to: number): CodeSelection | null => {
	const fence = enclosingFence(doc, from);
	if (!fence || fence.lines.length === 0) return null;

	const lastChar = Math.max(from, to - 1);
	let first = -1;
	let last = -1;
	fence.lines.forEach((line, i) => {
		if (line.from <= lastChar && from <= line.to) {
			if (first < 0) first = i;
			last = i;
		}
	});
	// Selection sat entirely on a fence line — fall back to the whole block.
	if (first < 0) {
		first = 0;
		last = fence.lines.length - 1;
	}

	const selected = fence.lines.slice(first, last + 1);
	return {
		fenceStart: fence.fenceStart,
		fenceEnd: fence.fenceEnd,
		quote: selected.map((line) => line.text).join("\n"),
		codeLines: { from: first, to: last },
	};
};

/** Resolve a code comment to the current source range of its target lines. Fast
 *  path: the stored line range still matches `quote`. Fallback: re-find `quote`
 *  as a contiguous run of lines (handles edits above it). Null → the code changed
 *  and the comment is orphaned. */
export const resolveCodeAnchor = (doc: string, comment: ParsedComment): TextRange | null => {
	if (!comment.codeLines) return null;
	const anchor = anchorRange(comment);
	if (!anchor) return null;
	const range = fencedRanges(doc).find(([fs, fe]) => fs >= anchor.from && fe <= anchor.to);
	if (!range) return null;
	const { lines } = fenceStructure(doc, range[0], range[1]);
	if (lines.length === 0) return null;

	const rangeOf = (from: number, count: number): { text: string; range: TextRange } | null => {
		const firstLine = lines[from];
		const lastLine = lines[from + count - 1];
		if (!firstLine || !lastLine) return null;
		return {
			text: lines
				.slice(from, from + count)
				.map((line) => line.text)
				.join("\n"),
			range: { from: firstLine.from, to: lastLine.to },
		};
	};

	const quote = comment.quote;
	const span = comment.codeLines.to - comment.codeLines.from + 1;
	const fast = rangeOf(comment.codeLines.from, span);
	if (fast && (quote === undefined || fast.text === quote)) return fast.range;

	if (quote !== undefined) {
		const count = quote.split("\n").length;
		for (let i = 0; i + count <= lines.length; i++) {
			const candidate = rangeOf(i, count);
			if (candidate && candidate.text === quote) return candidate.range;
		}
	}
	return null;
};

/** A code comment is one anchored to lines inside a fenced block. */
export const isCodeComment = (comment: ParsedComment): boolean => {
	return comment.codeLines !== undefined;
};
