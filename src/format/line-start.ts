import type { TextRange } from "./types";
import { commentsOutside, fencedRanges } from "./parse";
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

/** Whether a line is indented code, and the column its list item's text starts at. */
type CodeShape = { code: boolean; margin: number };

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
// A math block, a comment block, or a line Markdown reads as the start of an HTML
// block. With a marker in front, the line no longer opens its block, which then
// shows as text. Inline HTML followed by text (`<b>Note:</b> …`) isn't one.
const BLOCK_OPENER =
	/^(?:\$\$|%%|<(?:(?:script|pre|style|textarea)(?:\s|>|$)|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)))/i;
// A whole tag alone on its line, which Markdown also reads as an HTML block.
const LONE_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>\s*$/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// A list item's bullet or number, which its content starts after.
const ITEM_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
// A heading, rule, or fence, which no paragraph or list carries on into.
const BREAKS_BLOCK = new RegExp(`${HEADING.source}|${STRUCTURAL_LINE.source}`);

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
	const end = textEnd(doc, start, to);
	if (end <= start) return { from: start, to: start };
	const anchor = outOfCode(doc, start, end);
	const range = { from: outOfEscape(doc, anchor.from), to: outOfEscape(doc, anchor.to) };
	// Kept out of indented code, an anchor can be left holding nothing but white space.
	const moved = anchor.from !== start || anchor.to !== end;
	return moved && !doc.slice(range.from, range.to).trim() ? { from: start, to: start } : range;
};

/**
 * Keep an anchor's markers out of indented code, where they'd show as text. No
 * place inside the block hides a marker without splitting it in two, so the anchor
 * takes in the whole block, blank lines and all, with its markers on the lines
 * around it. Where there's no such line, a marker goes at the start of a code
 * line, as it always did, and that line shows as text instead.
 */
const outOfCode = (doc: string, from: number, to: number): TextRange => {
	const shapes = codeShapes(doc);
	const code = (lineFrom: number): boolean => shapes(lineFrom).code;
	const first = lineAround(doc, from);
	const last = lineAround(doc, to);
	// From the end of a code line, none of its code is selected, so the start goes
	// on to the next line, as a start there would.
	if (from >= first.to && first.to < to && code(first.from)) {
		const next = textStart(doc, doc.indexOf("\n", first.to) + 1);
		return next < to ? outOfCode(doc, next, to) : { from: to, to };
	}
	const opens = code(first.from);
	const closes = to > last.from && code(last.from);
	if (!opens && !closes) return { from, to };
	// In a list item, a marker line where a blank line was changes the list around
	// the code, pulling what follows into the item, so only top-level code is
	// wrapped. Each end goes by its own code line's list.
	const openMargin = opens ? shapes(first.from).margin : 0;
	const closeMargin = closes ? shapes(last.from).margin : 0;
	if (openMargin === 0 && closeMargin === 0) {
		const above = opens ? openerAbove(doc, blockEdge(doc, first, code, -1)) : null;
		const below = closes ? pastCodeLine(doc, blockEdge(doc, last, code, 1), code) : null;
		const clearBelow = below !== null && !code(lineAround(doc, below).from);
		if ((!opens || above !== null) && (!closes || clearBelow)) {
			return { from: above ?? from, to: closes ? (below ?? to) : to };
		}
	}
	// Otherwise a marker goes at the start of its code line's text column, where
	// it's hidden and the line shows as text. Checked in the app, in a list item
	// that keeps the line in the item. A closer on the opener's line is hidden with
	// the rest of it.
	const start = opens ? pastMarkers(doc, atColumn(doc, first, openMargin)) : from;
	if (!closes || (opens && first.from === last.from)) return { from: start, to };
	// A line of nothing but comments right after the code takes the closer without
	// changing anything around it, and one that can go back to the text before the
	// code doesn't touch the code at all.
	const next = neighborLine(doc, last, 1);
	const nextText = next ? doc.slice(next.from, next.to) : "";
	if (next && /^ {0,3}<!--/.test(nextText) && !showsText(nextText)) return { from: start, to: next.from };
	const back = endOfPlainTextBefore(doc, from, last.from);
	const after = closeMargin === 0 ? pastCodeLine(doc, last, code) : null;
	return { from: start, to: back ?? after ?? atColumn(doc, last, closeMargin) };
};

/** Past any markers at `pos`, where a new marker joins them. */
const pastMarkers = (doc: string, pos: number): number => {
	const markers = /(?:<!--\/?c:[A-Za-z0-9]+-->)*/y;
	markers.lastIndex = pos;
	return pos + (markers.exec(doc)?.[0].length ?? 0);
};

/** Whether the line past a blank line, in the direction of `step`, is a table's.
 *  The plugin's table repair reads a marker on that blank line as one breaking
 *  the table, so it stays blank. */
const besideTable = (doc: string, blank: TextRange, step: 1 | -1): boolean => {
	const beyond = neighborLine(doc, blank, step);
	return !!beyond && tableLines(doc)(beyond.from);
};

/** Where `line`'s indentation reaches `column`, or its text if sooner. */
const atColumn = (doc: string, line: TextRange, column: number): number => {
	const indent = INDENT.exec(doc.slice(line.from, line.to))?.[0] ?? "";
	const at = [...indent].findIndex((_, index) => columnsOf(indent.slice(0, index)) >= column);
	return line.from + (at < 0 ? indent.length : at);
};

/** The first or last line of the indented code block holding `line`, past any
 *  blank lines inside it. */
const blockEdge = (doc: string, line: TextRange, code: (lineFrom: number) => boolean, step: 1 | -1): TextRange => {
	// Each step reaches more code or stops, which no array method expresses.
	for (let edge = line; ;) {
		let next = neighborLine(doc, edge, step);
		while (next && !doc.slice(next.from, next.to).trim()) next = neighborLine(doc, next, step);
		if (!next || !code(next.from)) return edge;
		edge = next;
	}
};

const neighborLine = (doc: string, line: TextRange, step: 1 | -1): TextRange | null => {
	if (step < 0) return line.from > 0 ? lineAround(doc, line.from - 1) : null;
	const newline = doc.indexOf("\n", line.to);
	return newline < 0 ? null : lineAround(doc, newline + 1);
};

/** Where an opener can go above the code block starting at `top`: on a blank line,
 *  where it's an invisible HTML block of its own, or after the comments on a line
 *  of nothing else, where it joins them. Null when the line above is neither. */
const openerAbove = (doc: string, top: TextRange): number | null => {
	if (top.from === 0) return null;
	const above = lineAround(doc, top.from - 1);
	const text = doc.slice(above.from, above.to);
	if (!text.trim()) return besideTable(doc, above, -1) ? null : above.from;
	return /^ {0,3}<!--/.test(text) && !showsText(text) ? above.to : null;
};

/** How far a raw HTML block's opening tag at the start of `text` runs, or 0 when
 *  `text` opens no such block. In front of the tag, a marker makes the line a
 *  comment block instead, which ends right there and leaves the lines after it to
 *  render as something else. After the tag, the block stays as it was. */
export const htmlBlockTag = (text: string): number =>
	opensHtmlBlock(text) ? (/^<(?:"[^"]*"|'[^']*'|[^'">])*>/.exec(text)?.[0].length ?? 0) : 0;

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
	const markup = leadingMarkup(lineText).end;
	const text = line.from + markup + htmlBlockTag(lineText.slice(markup));
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
	const code = indentedCodeLines(doc);
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
			if (rows(line.from) || code(line.from) || opensBlock) return null;
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
	const markup = leadingMarkup(lineText).end;
	const text = line.from + markup + htmlBlockTag(lineText.slice(markup));
	if (!structural && to > text) return to;
	const back = endOfTextBefore(doc, from, line.from);
	if (back !== null) return back;
	// Back at the end of a line of indented code, the end stays there, and the
	// anchor takes in the code's whole lines once the ends are settled.
	const codeEnd = from + doc.slice(from, line.from).trimEnd().length;
	if (codeEnd > from && indentedCodeLines(doc)(lineAround(doc, codeEnd).from)) return codeEnd;
	// A rule or fence line has no place for the marker at all, so it goes back past
	// whatever stopped it to the last line of text, or the selection held none.
	if (structural) return endOfPlainTextBefore(doc, from, line.from) ?? from;
	// In front of a line of indented code, the end goes on the blank line above it,
	// or back to the text before whatever stopped it, rather than break the code.
	if (indentedCodeLines(doc)(line.from)) {
		return blankLineAbove(doc, line.from) ?? endOfPlainTextBefore(doc, from, line.from) ?? line.from;
	}
	// Where it can't go back, it goes past the markup instead, to start the text
	// with a guard rather than stop the line being a list item, quote, or heading.
	return lineText.trim() ? text : line.from;
};

/**
 * Where a closer goes past the code line `line`: alone on a blank line after it,
 * or past the markup of the text there. Only at the start of more code, which
 * then shows as text, and nowhere on a rule, fence, table, or block opener.
 */
const pastCodeLine = (doc: string, line: TextRange, code: (lineFrom: number) => boolean): number | null => {
	const newline = doc.indexOf("\n", line.to);
	if (newline < 0) return null;
	const next = lineAround(doc, newline + 1);
	const text = doc.slice(next.from, next.to);
	if (code(next.from)) return next.from;
	if (!text.trim()) return besideTable(doc, next, 1) ? null : next.from;
	const markup = leadingMarkup(text).end;
	const rest = text.slice(markup);
	if (STRUCTURAL_LINE.test(text) || BLOCK_OPENER.test(rest) || LONE_TAG.test(rest)) return null;
	return tableLines(doc)(next.from) ? null : skipGuard(doc, next.from + markup);
};

/**
 * The start of the line above `lineFrom` when it's blank. A marker there is an
 * invisible HTML block of its own, which keeps it out of the code below. With no
 * blank line, a marker at the code line's start is where it was always written:
 * invisible too, though the line then shows as text rather than code.
 */
const blankLineAbove = (doc: string, lineFrom: number): number | null => {
	if (lineFrom === 0) return null;
	const above = lineAround(doc, lineFrom - 1);
	return doc.slice(above.from, above.to).trim() ? null : above.from;
};

/** Where a marker leaving the start of the line at `lineFrom` can go: the end of
 *  the text before it, no further back than `floor`. Null when that ends a fence,
 *  rule, or table row, where the marker would break that line instead, or a line
 *  of indented code, where it would show as code. */
export const endOfTextBefore = (doc: string, floor: number, lineFrom: number): number | null => {
	const end = floor + doc.slice(floor, lineFrom).trimEnd().length;
	// With no text since `floor`, there's nothing for the marker to close on.
	if (end <= floor) return floor;
	const landed = lineAround(doc, end);
	if (STRUCTURAL_LINE.test(doc.slice(landed.from, landed.to))) return null;
	if (tableLines(doc)(landed.from) || indentedCodeLines(doc)(landed.from)) return null;
	return outOfEscape(doc, end);
};

/** `\<` is an escape, so a marker right after a backslash that isn't escaped
 *  itself shows as text. In front of it, the marker leaves the backslash ending
 *  the line, a hard break as before. */
const outOfEscape = (doc: string, pos: number): number => (isEscaped(doc, pos) ? pos - 1 : pos);

/** Whether a backslash that isn't escaped itself comes right before `pos`. */
export const isEscaped = (doc: string, pos: number): boolean => {
	let slashes = 0;
	for (let cursor = pos - 1; cursor >= 0 && doc.charAt(cursor) === "\\"; cursor--) slashes++;
	return slashes % 2 === 1;
};

/** The end of the last line of plain text before `lineFrom`, past fences, rules,
 *  table rows, and indented code, if it comes after `floor`. */
export const endOfPlainTextBefore = (doc: string, floor: number, lineFrom: number): number | null => {
	const fences = fencedRanges(doc);
	const rows = tableLines(doc);
	const code = indentedCodeLines(doc);
	// Walks back a line at a time and stops at the first that qualifies.
	for (let cursor = lineFrom - 1; cursor > floor;) {
		const line = lineAround(doc, cursor);
		const lineText = doc.slice(line.from, line.to);
		const inFence = fences.some(([fenceFrom, fenceTo]) => line.from >= fenceFrom && line.from <= fenceTo);
		const plain = !inFence && !STRUCTURAL_LINE.test(lineText) && !rows(line.from) && !code(line.from);
		if (lineText.trim() && plain) {
			const end = outOfEscape(doc, line.from + lineText.trimEnd().length);
			return end > floor ? end : null;
		}
		cursor = line.from - 1;
	}
	return null;
};

/**
 * A test for whether a line is in an indented code block, where a marker shows as
 * text. That's four columns of indentation past the text of the list item holding
 * the line, or past the margin outside a list, on a line that doesn't carry on a
 * paragraph. Comments, markers included, are left out of each line's text, as
 * markers the repair will move or guard. Checked against Obsidian's rendering
 * throughout, which differs from CommonMark around comments, quotes, and lists.
 */
export const indentedCodeLines = (doc: string): ((lineFrom: number) => boolean) => {
	const shape = codeShapes(doc);
	return (lineFrom) => shape(lineFrom).code;
};

/** `indentedCodeLines`, with the column the text of the list item holding each
 *  line starts at, or 0 outside a list. */
const codeShapes = (doc: string): ((lineFrom: number) => CodeShape) => {
	const lines = sourceLines(doc);
	const fences = fencedRanges(doc);
	const fenced = (pos: number): boolean => fences.some(([from, to]) => pos >= from && pos <= to);
	// Blank out each comment, keeping its line breaks so every line keeps its place.
	const chars = doc.split("");
	commentsOutside(doc, HTML_COMMENT, fenced).forEach(([from, to]) => {
		chars.fill("", from, to);
		chars[from] = doc.slice(from, to).replace(/[^\n]/g, "");
	});
	const shown = chars
		.join("")
		.split("\n")
		.map((line) => line.replace(/\r$/, ""));
	const at = (index: number): string => shown[index] ?? "";
	// A line of nothing but comments still counts in a list: checked in the app, one
	// right after an item stays in its list, and one after a blank line ends it.
	const blank = (index: number): boolean => !(lines[index]?.text ?? "").trim();
	// After a blank line, or as a heading, rule, or fence, a line starts a block of
	// its own rather than carrying on the list above it. Checked in the app, a quote
	// right after a list item stays in the item.
	const startsBlock = (index: number): boolean => blank(index - 1) || BREAKS_BLOCK.test(at(index));
	// A raw HTML block runs from its opening line to a blank line, and its lines are
	// its raw text: no list item, paragraph, or code of their own.
	const html = new Set<number>();
	// State carried from line to line, which no array method expresses.
	for (let index = 0, open = false; index < lines.length; index++) {
		const line = lines[index];
		if (!line || blank(index)) open = false;
		else if (!open && !fenced(line.from) && indentColumns(at(index)) < 4)
			open = opensHtmlBlock(at(index).trimStart());
		if (open) html.add(index);
	}
	const shapes = new Map<number, CodeShape>();

	const shapeOf = (index: number): CodeShape => {
		const known = shapes.get(index);
		if (known) return known;
		const shape = classify(index);
		shapes.set(index, shape);
		return shape;
	};

	const classify = (index: number): CodeShape => {
		const line = lines[index];
		const text = at(index);
		const indent = indentColumns(text);
		if (!line || fenced(line.from) || indent < 4 || !text.trim() || html.has(index))
			return { code: false, margin: 0 };
		const margin = marginOf(index, indent);
		if (indent < margin + 4) return { code: false, margin };
		// Indented code can't interrupt a paragraph, so the lines indented as far as
		// this one have to start after a blank line, a comment, a heading, a rule or
		// fence, or (checked in the app) a quote.
		const before = lineAbove(index, (above) => !at(above).trim() || indentColumns(at(above)) < margin + 4);
		if (before === null || !at(before).trim()) return { code: true, margin };
		return { code: BREAKS_BLOCK.test(at(before)) || QUOTE.test(at(before)), margin };
	};

	// The column the text of the list item holding a line starts at, or 0 outside a
	// list: the nearest item above whose text starts no further in than the blocks
	// between them. A block starting further out ends the items it's outside of.
	const marginOf = (index: number, indent: number): number => {
		let reach = indent;
		let endsFootnote = false;
		// A walk back with a bound that tightens as it goes, which no array method does.
		for (let above = index - 1; above >= 0; above--) {
			const text = at(above);
			const columns = indentColumns(text);
			if (blank(above)) continue;
			endsFootnote ||= !text.trim() || QUOTE.test(text);
			if (columns >= reach) continue;
			// The block sits where its first line does.
			if (html.has(above)) {
				if (!html.has(above - 1) && columns === 0) return 0;
				continue;
			}
			// Code that looks like a list item isn't one, and shares its holder.
			const shape = shapeOf(above);
			if (shape.code) return shape.margin;
			// A footnote's text goes on four columns in, like an item's. Checked in the
			// app, a footnote only opens after a blank line, and a comment or quote ends it.
			if (FOOTNOTE.test(text.trimStart()) && startsBlock(above)) {
				if (endsFootnote) return 0;
				if (columns + 4 <= reach) return columns + 4;
				reach = columns;
				continue;
			}
			// Four columns past its own holder's text, a bullet carries on a paragraph
			// rather than opening an item.
			const content = columns < shape.margin + 4 ? itemContent(text) : null;
			if (content !== null && content <= reach) return content;
			if (content === null && columns === 0 && startsBlock(above)) return 0;
			if (content !== null || startsBlock(above)) reach = columns;
		}
		return 0;
	};

	// The nearest line above `index` that passes `test`. A walk back that stops
	// there, which no array method does without copying every line above.
	const lineAbove = (index: number, test: (above: number) => boolean): number | null => {
		for (let above = index - 1; above >= 0; above--) if (test(above)) return above;
		return null;
	};

	return (lineFrom) => shapeOf(lineIndexAt(lines, lineFrom));
};

/** The column `prefix` ends at, a tab moving on to the next multiple of four. */
const columnsOf = (prefix: string): number =>
	[...prefix].reduce((column, char) => (char === "\t" ? column + 4 - (column % 4) : column + 1), 0);

const indentColumns = (line: string): number => columnsOf(INDENT.exec(line)?.[0] ?? "");

/** The column a list item's text starts at, or null when the line doesn't open one. */
const itemContent = (line: string): number | null => {
	const marker = ITEM_MARKER.exec(line)?.[0];
	if (marker === undefined) return null;
	const spaced = marker + (INDENT.exec(line.slice(marker.length))?.[0] ?? "");
	const markerEnd = columnsOf(marker);
	// With nothing after the bullet, or more than four columns of space before the
	// text, the item's text starts one column past the bullet.
	const content =
		!line.slice(spaced.length).trim() || columnsOf(spaced) - markerEnd > 4 ? markerEnd + 1 : columnsOf(spaced);
	// Checked in the app, an ordered item's text sits at least four columns in.
	return /\d[.)]$/.test(marker) ? Math.max(content, indentColumns(line) + 4) : content;
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
 * inline, and a table's body rows, which stay rows. A marker with nothing but
 * comments after it on the line is already invisible, and one in front of a raw
 * HTML block leaves it a block.
 */
export const needsMarkerGuard = (doc: string, pos: number): boolean => {
	const line = lineAround(doc, pos);
	const markup = leadingMarkup(doc.slice(line.from, line.to));
	const rest = doc.slice(pos, line.to);
	if (pos !== line.from + markup.end || markup.heading || !showsText(rest) || opensHtmlBlock(rest)) return false;
	return !tableBodyRows(doc)(line.from);
};

/** Whether text starting a line opens a raw HTML block. A marker in front leaves
 *  it one, where a guard would make it a paragraph. */
export const opensHtmlBlock = (text: string): boolean =>
	text.startsWith("<") && (BLOCK_OPENER.test(text) || LONE_TAG.test(text));

/** Whether a stretch of a line shows anything once its comments are left out. A
 *  line starting with a marker and holding nothing else is an invisible HTML block,
 *  and a guard in front would make it an empty paragraph instead. */
export const showsText = (text: string): boolean => text.replace(HTML_COMMENT, "").trim() !== "";

/** A test for whether the line starting at an offset is a table row below its header. */
export const tableBodyRows = (doc: string): ((lineFrom: number) => boolean) => {
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	return (lineFrom) => {
		const index = lineIndexAt(lines, lineFrom);
		return tables.some((table) => index > table.start && index < table.end);
	};
};
