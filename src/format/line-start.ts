import type { TextRange } from "./types";
import { fencedRanges } from "./parse";
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
// A fence, rule, setext underline, or empty bullet: a line with no text of its own,
// where a marker at either end breaks the line.
const STRUCTURAL_LINE = /^[ \t]*(?:`{3,}|~{3,}|(?:[-*_=][ \t]*)+$)/;
// Four columns of indentation, a tab counting as four, start an indented code block.
const CODE_INDENT = /^(?: {4}| {0,3}\t)/;
// A math block, a comment block, or a line Markdown reads as the start of an HTML
// block. With a marker in front, the line no longer opens its block, which then
// shows as text. Inline HTML followed by text (`<b>Note:</b> …`) isn't one.
const BLOCK_OPENER =
	/^(?:\$\$|%%|<(?:(?:script|pre|style|textarea)(?:\s|>|$)|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)))/i;
// A whole tag alone on its line, which Markdown also reads as an HTML block.
const LONE_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>\s*$/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** A fence, rule, setext underline, or empty bullet: a line with no text of its own. */
export const isStructuralLine = (line: string): boolean => STRUCTURAL_LINE.test(line);

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

/** The line holding `pos`, without its line break, CR included, so the patterns
 *  read a file with Windows line endings the same way. */
export const lineAround = (doc: string, pos: number): TextRange => {
	const newline = doc.indexOf("\n", pos);
	const end = newline < 0 ? doc.length : newline;
	// lastIndexOf clamps a negative start to 0, which would find a newline AT 0.
	const from = pos > 0 ? doc.lastIndexOf("\n", pos - 1) + 1 : 0;
	return { from, to: end > from && pos < end && doc.charAt(end - 1) === "\r" ? end - 1 : end };
};

/**
 * Keep an anchor's ends on text, off the markup and the lines around it.
 *
 * In front of a list bullet, quote marker, or heading's `#`s, the open marker
 * stops the line being a list item, quote, or heading at all, and a triple-clicked
 * line put it exactly there. At or before the text of a later line, the close
 * marker starts that line's text, so it comes back to the text the selection ends
 * on. Neither end stays on a rule, setext underline, or fence line, which a marker
 * anywhere on breaks, and a start on a blank line moves on to the text after it,
 * so a loose list keeps its blank lines.
 */
export const anchorOffBlockMarkup = (doc: string, from: number, to: number): TextRange => {
	const start = textStart(doc, from);
	if (start >= to) return { from: start, to: start };
	return { from: start, to: Math.max(start, textEnd(doc, start, to)) };
};

const textStart = (doc: string, from: number): number => {
	const line = lineAround(doc, from);
	const lineText = doc.slice(line.from, line.to);
	if (!lineText.trim() || STRUCTURAL_LINE.test(lineText)) {
		const blank = !lineText.trim();
		const next = nextTextStart(doc, line.to, !blank);
		if (next !== null) return next;
		// Before a fence, table, or indented code, a blank line keeps the marker at its
		// start, an invisible HTML block of its own. Past four columns of indentation it
		// would start a code block instead, or join the paragraphs on either side. A
		// rule has no such place, so nothing gets anchored.
		return blank ? line.from : doc.length;
	}
	const text = line.from + leadingMarkup(lineText).end;
	if (from > text) return from;
	return skipGuard(doc, text);
};

/** Behind an existing guard, a new marker shares it instead of adding another. */
const skipGuard = (doc: string, pos: number): number => (doc.charAt(pos) === MARKER_GUARD ? pos + 1 : pos);

/**
 * Where the text starts on the first line after `lineEnd` that has some, past
 * blank lines, rules, and underlines. Null at a table, indented code, or a line
 * opening a math, comment, or HTML block, and at a fence unless `pastCode`, which
 * steps over the whole fenced block instead.
 */
export const nextTextStart = (doc: string, lineEnd: number, pastCode: boolean): number | null => {
	const fences = fencedRanges(doc);
	const rows = tableLines(doc);
	// A scan with two ways to stop and one to skip ahead, which no array method expresses.
	for (let cursor = doc.indexOf("\n", lineEnd); cursor >= 0 && cursor < doc.length;) {
		const line = lineAround(doc, cursor + 1);
		const lineText = doc.slice(line.from, line.to);
		const fence = fences.find(([fenceFrom, fenceTo]) => line.from >= fenceFrom && line.from <= fenceTo);
		if (fence) {
			if (!pastCode) return null;
			cursor = doc.indexOf("\n", fence[1]);
			continue;
		}
		const text = line.from + leadingMarkup(lineText).end;
		const rest = doc.slice(text, line.to);
		// A line of nothing but comments is invisible, so look past it. One that opens
		// a comment and doesn't close it on the line is a block like any other.
		const visible = rest.replace(HTML_COMMENT, "");
		if (lineText.trim() && !STRUCTURAL_LINE.test(lineText) && visible.trim()) {
			const opensBlock = BLOCK_OPENER.test(rest) || LONE_TAG.test(rest) || visible.includes("<!--");
			if (rows(line.from) || CODE_INDENT.test(lineText) || opensBlock) return null;
			return skipGuard(doc, text);
		}
		cursor = doc.indexOf("\n", line.from);
	}
	return null;
};

const textEnd = (doc: string, from: number, to: number): number => {
	const line = lineAround(doc, to);
	if (line.from <= from) return to;
	const lineText = doc.slice(line.from, line.to);
	const structural = STRUCTURAL_LINE.test(lineText);
	const text = line.from + leadingMarkup(lineText).end;
	if (!structural && to > text) return to;
	const back = endOfTextBefore(doc, from, line.from);
	if (back !== null) return back;
	// A rule or fence line has no place for the marker at all, so it goes back past
	// whatever stopped it to the last line of text, or the selection held none.
	if (structural) return endOfPlainTextBefore(doc, from, line.from) ?? from;
	// Where it can't go back, it goes past the markup instead, to start the text
	// with a guard rather than stop the line being a list item, quote, or heading.
	return lineText.trim() ? text : line.from;
};

/** Where a marker leaving the start of the line at `lineFrom` can go: the end of
 *  the text before it, no further back than `floor`. Null when that ends a fence,
 *  rule, or table row, where the marker would break that line instead. */
export const endOfTextBefore = (doc: string, floor: number, lineFrom: number): number | null => {
	const end = floor + doc.slice(floor, lineFrom).trimEnd().length;
	const landed = lineAround(doc, end);
	if (STRUCTURAL_LINE.test(doc.slice(landed.from, landed.to))) return null;
	return tableLines(doc)(landed.from) ? null : end;
};

/** The end of the last line of plain text before `lineFrom`, past fences, rules,
 *  and table rows, if it comes after `floor`. */
export const endOfPlainTextBefore = (doc: string, floor: number, lineFrom: number): number | null => {
	const fences = fencedRanges(doc);
	const rows = tableLines(doc);
	// Walks back a line at a time and stops at the first that qualifies.
	for (let cursor = lineFrom - 1; cursor > floor;) {
		const line = lineAround(doc, cursor);
		const lineText = doc.slice(line.from, line.to);
		const inFence = fences.some(([fenceFrom, fenceTo]) => line.from >= fenceFrom && line.from <= fenceTo);
		if (lineText.trim() && !inFence && !STRUCTURAL_LINE.test(lineText) && !rows(line.from)) {
			const end = line.from + lineText.trimEnd().length;
			return end > floor ? end : null;
		}
		cursor = line.from - 1;
	}
	return null;
};

/** A test for whether the line starting at an offset is part of a table. */
const tableLines = (doc: string): ((lineFrom: number) => boolean) => {
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	return (lineFrom) => {
		const index = lineIndexAt(lines, lineFrom);
		return tables.some((table) => index >= table.start && index < table.end);
	};
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
