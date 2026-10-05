import { TextRange } from "./types";

export type SourceLine = { text: string; from: number; to: number };
/** A table's line span (`start` inclusive, `end` exclusive) and offset span. */
export type SourceTable = { start: number; end: number; from: number; to: number };
type TableKind = "normal" | "simple";

// Obsidian decides where a table starts and stops with these line shapes, and
// the Live-Preview table widget spans exactly the run of lines they cover. Ours
// has to agree: a looser rule hands the renderer a row index its DOM doesn't
// have, and a stricter one drops a table the reader can plainly see.
//
// A "normal" table draws outer pipes and continues only while a line STARTS with
// one — which is why a row that doesn't (one whose leading pipe a comment marker
// displaced, say) truncates the table there. A "simple" table draws no outer
// pipes and continues while a line starts with a non-pipe and contains a pipe.
//
// These are Obsidian's own patterns, lifted from its bundled tokenizer, and they
// are deliberately stricter than GFM. Each of these GFM-valid shapes renders as
// plain text in Obsidian, with no table widget — checked in the app:
//
//   indented by spaces or a tab · nested in a list item · inside a blockquote ·
//   a header with only one of its two outer pipes
//
// Don't widen the patterns to catch them. With no widget there is nothing to
// measure a row against, so the ordinary text path already highlights and aligns
// their comments, and a marker can't break a table that never rendered as one.
// test/table-anchors.test.ts pins each shape.
const NORMAL_HEADER = /^\|(?:[^|]+\|)+?\s*$/;
const SIMPLE_HEADER = /^\s*[^|].*?\|.*[^|]\s*$/;
const NORMAL_ROW = /^\|/;
const SIMPLE_ROW = /^\s*[^|].*\|/;
// One dash per column is enough here — Obsidian is looser than GFM's three.
const DELIMITER_CELL = /^\s*:?\s*-+\s*:?\s*$/;
// Setext underlines are let through with ATX headings. Treating one as a table's
// opener errs toward recognizing a table Obsidian doesn't draw, which is harmless;
// the other way round would strip a real table of its clamp and its alignment.
const HEADING = /^ {0,3}(?:#{1,6}(?:\s|$)|=+\s*$|-+\s*$)/;

export const sourceLines = (doc: string): SourceLine[] => {
	const lines: SourceLine[] = [];
	let from = 0;
	for (const text of doc.split("\n")) {
		lines.push({ text, from, to: from + text.length });
		from += text.length + 1;
	}
	return lines;
};

export const sourceTables = (lines: readonly SourceLine[]): SourceTable[] => {
	// Scanner that consumes a variable run of rows per table and advances `start`
	// past it — a for loop is the natural fit, not an array method.
	const tables: SourceTable[] = [];
	for (let start = 0; start + 1 < lines.length; start++) {
		const head = lines[start];
		const delimiter = lines[start + 1];
		if (!head || !delimiter || !opensTableBelow(lines[start - 1])) continue;
		const kind = tableKind(head.text, delimiter.text);
		if (!kind) continue;
		const isRow =
			kind === "normal"
				? (text: string) => NORMAL_ROW.test(text)
				: (text: string) => SIMPLE_ROW.test(tokenizable(text));
		let end = start + 2;
		let row = lines[end];
		while (row && isRow(row.text)) {
			end++;
			row = lines[end];
		}
		const lastRow = lines[end - 1];
		if (!lastRow) continue;
		tables.push({ start, end, from: head.from, to: lastRow.to });
		start = end - 1;
	}
	return tables;
};

/**
 * The part of a line still tokenized as Markdown. Text after an HTML comment
 * that does NOT close on the line sits inside a comment token running past the
 * line end, so a pipe there never becomes a cell separator.
 *
 * That is what lets a comment's own `<!--co:…-->` block sit directly beneath a
 * pipe-less table without being read as another row, even when its `quote:`
 * carries a pipe — confirmed in the app, where the same table followed by a
 * plain `ordinary line | with a pipe` DOES grow a row. A comment that opens and
 * closes on the line (an anchor marker) leaves the rest of the line tokenizing
 * normally, so a row starting with one is still a row.
 */
const tokenizable = (line: string): string => {
	// A scan, not a transform: each step depends on where the previous comment
	// closed, and it exits at whichever of two conditions comes first.
	let cursor = 0;
	for (;;) {
		const open = line.indexOf("<!--", cursor);
		if (open < 0) return line;
		const close = line.indexOf("-->", open + 4);
		if (close < 0) return line.slice(0, open);
		cursor = close + 3;
	}
};

/**
 * Whether a table may start on the line after `above`. Obsidian's tokenizer only
 * looks for a header below a blank line, a heading, or the top of the note
 * (`prevLine.stream.string.trim() && !wasHeading`). Checked in the app: prose, a
 * comment's own block, or a marker alone on the line above leaves the whole table
 * as plain text.
 */
const opensTableBelow = (above: SourceLine | undefined): boolean => {
	return !above || above.text.trim() === "" || HEADING.test(above.text);
};

/** Which flavor of table `head` opens, or null when it opens none. */
const tableKind = (head: string, delimiter: string): TableKind | null => {
	if (NORMAL_HEADER.test(head)) {
		if (!NORMAL_HEADER.test(delimiter)) return null;
		// The outer pipes aren't columns, so drop them before splitting.
		return isDelimiterRow(delimiter.replace(/^\s*\|/, "").replace(/\|\s*$/, "")) ? "normal" : null;
	}
	if (SIMPLE_HEADER.test(head)) {
		if (!SIMPLE_HEADER.test(delimiter)) return null;
		return isDelimiterRow(delimiter) ? "simple" : null;
	}
	return null;
};

const isDelimiterRow = (line: string): boolean => {
	return line.split("|").every((cell) => DELIMITER_CELL.test(cell));
};

/** Whether a whole source line reads as a table's delimiter row, either flavor. */
export const isDelimiterLine = (line: string): boolean => {
	const inner = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
	return inner.trim().length > 0 && isDelimiterRow(inner);
};

/** Total rows every table in `text` covers. Rises when a repair reveals more table. */
export const tableCoverage = (text: string): number => {
	return sourceTables(sourceLines(text)).reduce((rows, table) => rows + (table.end - table.start), 0);
};

/** Zero-based column of `offset` within a table row, ignoring the leading pipe. */
export const tableColumnAt = (line: string, offset: number): number => {
	const pipes = unescapedPipes(line);
	const firstNonSpace = line.search(/\S/);
	const leadingPipe = pipes[0] === firstNonSpace ? pipes[0] : null;
	return pipes.filter((pipe) => pipe < offset && pipe !== leadingPipe).length;
};

const unescapedPipes = (line: string): number[] => {
	const pipes: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "|") continue;
		let slashes = 0;
		for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
		if (slashes % 2 === 0) pipes.push(i);
	}
	return pipes;
};

/**
 * Pull a selection inside the outer pipes of any table row it touches, then trim
 * the whitespace that padding leaves on the edges.
 *
 * A comment marker written outside those pipes breaks the row it lands on:
 * Obsidian keeps an outer-pipe table going only while each line starts with a
 * pipe, and reads a header only while it ends with one. So anchoring a whole row
 * used to drop that row and everything after it out of the rendered table, and
 * anchoring a whole table stopped it rendering as a table at all. Inside the
 * pipes the markers are ordinary cell text and the table holds together.
 *
 * Returns an empty range when the selection held nothing but borders and
 * padding, which the caller reports rather than anchoring.
 */
export const clampToTableCells = (doc: string, from: number, to: number): TextRange => {
	if (to <= from) return { from, to };
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	if (tables.length === 0) return { from, to };
	const touchesTable = !!tableAt(tables, lineIndexAt(lines, from)) || !!tableAt(tables, lineIndexAt(lines, to));

	// Trim BEFORE deciding which ends sit in a table. Trimmed afterwards, an end
	// left outside the table gets dragged across blank lines onto the table's own
	// border, and a marker there stops it rendering. Trimmed first, a selection
	// starting on the blank line above a table starts in the table and is clamped
	// like one, while one starting in prose stays on that prose.
	const selected = trimRange(doc, from, to);
	const fromIndex = lineIndexAt(lines, selected.from);
	const toIndex = lineIndexAt(lines, selected.to);
	const head = tableAt(tables, fromIndex);
	const tail = tableAt(tables, toIndex);
	if (!head && !tail) {
		// Only whitespace tied the selection to a table, or an end sits on the blank
		// line a table needs above it — as when a triple-click takes a paragraph's
		// newline. Either way the markers belong on the selected text. A selection
		// that touches neither is left exactly as it was.
		const fillsGap = [from, to].some((pos) => isGapAboveTable(lines, tables, lineIndexAt(lines, pos)));
		return touchesTable || fillsGap ? selected : { from, to };
	}

	const start = head ? anchorablePosition(lines, head, fromIndex, selected.from, 1) : selected.from;
	const end = tail ? anchorablePosition(lines, tail, toIndex, selected.to, -1) : selected.to;
	if (start === null || end === null || end <= start) return { from, to: from };
	const trimmed = trimRange(doc, start, end);
	if (trimmed.to <= trimmed.from) return { from, to: from };
	// A marker between a backslash and the pipe it escapes un-escapes that pipe,
	// splitting the cell in two and showing the marker as text. Keep the pair whole.
	const range = {
		from: splitsEscapedPipe(doc, trimmed.from) ? trimmed.from - 1 : trimmed.from,
		to: splitsEscapedPipe(doc, trimmed.to) ? trimmed.to + 1 : trimmed.to,
	};
	// Clamping only moves the two ends, so a selection between two rows or around a
	// separator still holds nothing but the pipes that divide cells.
	return holdsCellText(doc, range) ? range : { from, to: from };
};

/** Whether `pos` falls between a backslash and the pipe it escapes. */
const splitsEscapedPipe = (doc: string, pos: number): boolean => {
	if (doc[pos] !== "|") return false;
	const before = doc.slice(doc.lastIndexOf("\n", pos - 1) + 1, pos);
	const slashes = before.length - before.replace(/\\+$/, "").length;
	return slashes % 2 === 1;
};

/** Whether `range` holds anything besides whitespace and unescaped cell pipes. */
const holdsCellText = (doc: string, range: TextRange): boolean => {
	// Scan from the line start: the backslash escaping a pipe can sit just before
	// the range, and a pipe it escapes is cell text, not a border.
	const lineStart = doc.lastIndexOf("\n", range.from - 1) + 1;
	const pipes = new Set(unescapedPipes(doc.slice(lineStart, range.to)).map((pipe) => lineStart + pipe));
	return doc
		.slice(range.from, range.to)
		.split("")
		.some((char, index) => !pipes.has(range.from + index) && char.trim() !== "");
};

/** Whether a line is the blank one a table depends on to render at all. */
const isGapAboveTable = (lines: readonly SourceLine[], tables: readonly SourceTable[], lineIndex: number): boolean => {
	return lines[lineIndex]?.text.trim() === "" && tables.some((table) => table.start === lineIndex + 1);
};

const tableAt = (tables: readonly SourceTable[], lineIndex: number): SourceTable | undefined => {
	return tables.find((table) => lineIndex >= table.start && lineIndex < table.end);
};

/**
 * Where a marker may sit at or beyond `pos`, searching in `step`'s direction for
 * the first row of `table` that can hold one. Null when the table has no such row.
 */
const anchorablePosition = (
	lines: readonly SourceLine[],
	table: SourceTable,
	lineIndex: number,
	pos: number,
	step: 1 | -1,
): number | null => {
	// Walks in a caller-chosen direction and stops at the first usable row, which
	// no single array method expresses.
	for (let index = lineIndex; index >= table.start && index < table.end; index += step) {
		// The delimiter row has to stay nothing but dashes and colons, so a marker
		// dropped there stops the whole block reading as a table. Step over it.
		if (index === table.start + 1) continue;
		const line = lines[index];
		if (!line) continue;
		const bounds = cellBounds(line);
		if (bounds.to <= bounds.from) continue; // borders all the way across
		return Math.min(Math.max(pos, bounds.from), bounds.to);
	}
	return null;
};

/** The offsets a table row's cell content may occupy, excluding its outer pipes. */
const cellBounds = (line: SourceLine): TextRange => {
	const pipes = unescapedPipes(line.text);
	const first = pipes[0];
	const last = pipes[pipes.length - 1];
	const start = first !== undefined && first === line.text.search(/\S/) ? first + 1 : 0;
	// Only a pipe with nothing but whitespace after it is a closing border; on a
	// row without one the last pipe is a cell separator and content runs past it.
	const end = last !== undefined && line.text.slice(last + 1).trim() === "" ? last : line.text.length;
	return { from: line.from + start, to: line.from + Math.max(start, end) };
};

export const lineIndexAt = (lines: readonly SourceLine[], pos: number): number => {
	return lines.findIndex((line) => pos >= line.from && pos <= line.to);
};

const trimRange = (doc: string, from: number, to: number): TextRange => {
	const text = doc.slice(from, to);
	const leading = text.length - text.trimStart().length;
	const trailing = text.length - text.trimEnd().length;
	const start = from + leading;
	return { from: start, to: Math.max(start, to - trailing) };
};
