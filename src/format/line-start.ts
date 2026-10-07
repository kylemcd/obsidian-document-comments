import type { TextRange } from "./types";
import { lineIndexAt, sourceLines, sourceTables } from "./table";

/**
 * Markdown reads a line whose text starts with `<!--` as a raw HTML block, and
 * Reading view then shows the whole line as-is: no highlights, bold, links, or
 * any other formatting. Live Preview has its own parser and shows the line
 * normally, so a comment starting a paragraph, list item, or quote only broke
 * Reading view (#94).
 *
 * A zero-width space in front of the marker makes the line ordinary text, which
 * leaves the marker an inline comment. It renders as nothing anywhere.
 */
export const MARKER_GUARD = "\u200b";

export type LeadingMarkup = {
	/** Offset in the line where its text starts, past indentation and block markup. */
	end: number;
	/** Heading text is always inline, so a marker starting it needs no guard. */
	heading: boolean;
};

const QUOTE = /^[ \t]*>[ \t]?/;
// A bullet or number, then the task box the item may open with. Obsidian takes any
// single character as a task's status.
const LIST_ITEM = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+(?:\[[^\]\n]\](?:[ \t]+|$))?|$)/;
const HEADING = /^[ \t]*#{1,6}(?:[ \t]+|$)/;
const CALLOUT = /^\[![^\]\n]*\][-+]?(?:[ \t]+|$)/;
const FOOTNOTE = /^\[\^[^\]\n]+\]:(?:[ \t]+|$)/;
const INDENT = /^[ \t]*/;
// A fence, rule, or setext underline: a marker at the end of one breaks the line.
const STRUCTURAL_LINE = /^[ \t]*(?:`{3,}|~{3,}|(?:[-*_=][ \t]*)+$)/;

/** Where a line's text starts: past its indentation, quote markers, list bullet
 *  and task box, then a heading's `#`s, a callout's `[!type]`, or a footnote label. */
export const leadingMarkup = (line: string): LeadingMarkup => {
	let end = 0;
	let quoted = false;
	// Quotes and list items nest in either order (`> - `, `- > `), so peel them off
	// one at a time until neither matches.
	for (;;) {
		const rest = line.slice(end);
		const quote = QUOTE.exec(rest);
		const piece = quote ?? LIST_ITEM.exec(rest);
		if (!piece) break;
		end += piece[0].length;
		quoted = !!quote;
	}
	const rest = line.slice(end);
	const heading = HEADING.exec(rest);
	if (heading) return { end: end + heading[0].length, heading: true };
	const label = (quoted ? CALLOUT.exec(rest) : null) ?? FOOTNOTE.exec(rest);
	const text = end + (label?.[0].length ?? 0);
	return { end: text + (INDENT.exec(line.slice(text))?.[0].length ?? 0), heading: false };
};

/** The line holding `pos`, without its line break. */
export const lineAround = (doc: string, pos: number): TextRange => {
	const end = doc.indexOf("\n", pos);
	// lastIndexOf clamps a negative start to 0, which would find a newline AT 0.
	return { from: pos > 0 ? doc.lastIndexOf("\n", pos - 1) + 1 : 0, to: end < 0 ? doc.length : end };
};

/**
 * Keep an anchor's ends off the block markup a line opens with. In front of a
 * list bullet, quote marker, or heading's `#`s, the open marker stops the line
 * being a list item, quote, or heading at all, and a triple-clicked line put it
 * exactly there. At or before the text of a later line, the close marker starts
 * that line's text, so it comes back to the text the selection ends on.
 */
export const anchorOffBlockMarkup = (doc: string, from: number, to: number): TextRange => {
	const start = textStart(doc, from);
	return { from: start, to: Math.max(start, textEnd(doc, start, to)) };
};

const textStart = (doc: string, from: number): number => {
	const line = lineAround(doc, from);
	const text = line.from + leadingMarkup(doc.slice(line.from, line.to)).end;
	// A line with no text of its own keeps the marker where the selection put it.
	if (from > text || !doc.slice(text, line.to).trim()) return from;
	// Behind an existing guard, the new marker shares it instead of adding another.
	return doc.charAt(text) === MARKER_GUARD ? text + 1 : text;
};

const textEnd = (doc: string, from: number, to: number): number => {
	const line = lineAround(doc, to);
	if (line.from <= from || to > line.from + leadingMarkup(doc.slice(line.from, line.to)).end) return to;
	return endOfTextBefore(doc, from, line.from) ?? to;
};

/** Where a marker leaving the start of the line at `lineFrom` can go: the end of
 *  the text before it, no further back than `floor`. Null when that ends a fence,
 *  rule, or table row, where the marker would break that line instead. */
export const endOfTextBefore = (doc: string, floor: number, lineFrom: number): number | null => {
	const end = floor + doc.slice(floor, lineFrom).trimEnd().length;
	const landed = lineAround(doc, end);
	if (STRUCTURAL_LINE.test(doc.slice(landed.from, landed.to))) return null;
	const lines = sourceLines(doc);
	const index = lineIndexAt(lines, landed.from);
	return sourceTables(lines).some((table) => index >= table.start && index < table.end) ? null : end;
};

/**
 * Whether a marker inserted at `pos` would start its line's text, so it needs
 * the guard. Checked in the app, two places never do: a heading, whose text is
 * inline, and a table's body rows, which stay rows. A marker with nothing after
 * it on the line is already invisible, and guarded it would render as an empty
 * paragraph instead.
 */
export const needsMarkerGuard = (doc: string, pos: number): boolean => {
	const line = lineAround(doc, pos);
	const markup = leadingMarkup(doc.slice(line.from, line.to));
	if (pos !== line.from + markup.end || markup.heading || !doc.slice(pos, line.to).trim()) return false;
	return !tableBodyRows(doc)(line.from);
};

/** A test for whether the line starting at an offset is a table row below its header. */
export const tableBodyRows = (doc: string): ((lineFrom: number) => boolean) => {
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	return (lineFrom) => {
		const index = lineIndexAt(lines, lineFrom);
		return tables.some((table) => index > table.start && index < table.end);
	};
};
