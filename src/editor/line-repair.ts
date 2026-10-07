import { Result } from "better-result";
import { isCodeComment } from "../format/code-anchor";
import { parseComments } from "../format/parse";
import type { ParsedComment, TextRange } from "../format/types";
import {
	MARKER_GUARD,
	endOfPlainTextBefore,
	endOfTextBefore,
	indentedCodeLines,
	isEscaped,
	leadingMarkup,
	lineAround,
	needsMarkerGuard,
	nextTextStart,
	showsText,
	tableBodyRows,
} from "../format/line-start";
import type { Change } from "./edits";

/**
 * Finding and undoing the damage a comment written before markers were kept off
 * the start of a line can do (#94).
 *
 * A run of markers that starts a line's text turns the line into a raw HTML
 * block, which Reading view shows without any formatting; a guard in front of
 * the run fixes that. A run in front of a list bullet, quote marker, or heading's
 * `#`s, where a triple-clicked line put it, also stops the line being a list
 * item, quote, or heading, so the run moves past that markup as well.
 */

type Marker = TextRange & { id: string; closing: boolean };

// A thematic break or setext underline, which a marker anywhere on stops being one.
// A lone bullet is left out: a marker after it only fills an empty list item.
const RULE = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+|-{2,})[ \t]*$/;
type RunRepair = { ids: string[]; changes: Change[] };

/** The anchor markers the parser recognized, in document order. A code comment's
 *  markers sit alone on their lines around a fence by design. */
const anchorMarkers = (comments: readonly ParsedComment[]): Marker[] => {
	return comments
		.filter((comment) => !isCodeComment(comment))
		.flatMap((comment) => [
			...(comment.open ? [{ ...comment.open, id: comment.id, closing: false }] : []),
			...(comment.close ? [{ ...comment.close, id: comment.id, closing: true }] : []),
		])
		.sort((a, b) => a.from - b.from);
};

/** Markers that touch end to start, like `<!--/c:a--><!--c:b-->`, read as one. */
const markerRuns = (markers: readonly Marker[]): Marker[][] => {
	return markers.reduce<Marker[][]>((runs, marker) => {
		const run = runs[runs.length - 1];
		if (run && run[run.length - 1]?.to === marker.from) run.push(marker);
		else runs.push([marker]);
		return runs;
	}, []);
};

/**
 * The edit that stops `run` starting its line's text, or null when the run is
 * fine where it is or can't be moved without emptying a comment.
 */
const repairRun = (
	doc: string,
	run: readonly Marker[],
	comments: ReadonlyMap<string, ParsedComment>,
	bodyRow: (lineFrom: number) => boolean,
	codeLine: (lineFrom: number) => boolean,
): Change[] | null => {
	const first = run[0];
	const last = run[run.length - 1];
	if (!first || !last) return null;
	if (isEscaped(doc, first.from)) return outOfEscape(doc, run, comments);
	const line = lineAround(doc, first.from);
	const text = doc.slice(first.from, last.to);
	const offset = first.from - line.from;
	const lineText = doc.slice(line.from, line.to);
	const bare = lineText.slice(0, offset) + lineText.slice(offset + text.length);
	if (RULE.test(bare)) return offRule(doc, run, line, comments);
	// Where the line's text would start without the run. Past the run means the run
	// is mid-line (or behind a guard, which counts as text), and fine.
	const markup = leadingMarkup(bare);
	if (offset > markup.end) return null;
	const rest = doc.slice(last.to, line.to);
	// Alone on its line, or with nothing but comments after it, the run is an
	// invisible HTML block already. In front of a row's leading pipe, it's the
	// table repair's to put right.
	if (!showsText(rest) || rest.trimStart().startsWith("|") || bodyRow(line.from)) return null;
	if (codeLine(line.from)) return offCodeLine(doc, run, line, comments);

	if (offset === markup.end) {
		return markup.heading ? null : [{ from: first.from, to: first.from, insert: MARKER_GUARD }];
	}

	// The run sits in front of block markup. Openers move past it. A closer goes
	// back to the end of the text it closes on, unless that's a fence or rule.
	const target = line.from + markup.end + text.length;
	const back = endOfTextBefore(doc, 0, line.from);
	const leaving = back === null ? [] : run.filter((marker) => marker.closing);
	const staying = run.filter((marker) => !leaving.includes(marker));
	// Neither move may leave a comment with no text.
	const keepsText = (marker: Marker): boolean => {
		const comment = comments.get(marker.id);
		if (!marker.closing) return !!comment?.close && comment.close.from > target;
		if (!leaving.includes(marker)) return true;
		return !!comment?.open && back !== null && comment.open.to < back;
	};
	if (!run.every(keepsText)) return null;

	const textOf = (markers: readonly Marker[]): string =>
		markers.map((marker) => doc.slice(marker.from, marker.to)).join("");
	const guarded = staying.length > 0 && !markup.heading && doc.slice(target, line.to).trim() !== "";
	const changes: Change[] = [
		{
			from: first.from,
			to: target,
			insert: doc.slice(last.to, target) + (guarded ? MARKER_GUARD : "") + textOf(staying),
		},
	];
	if (back !== null && leaving.length > 0) changes.push({ from: back, to: back, insert: textOf(leaving) });
	return changes;
};

/** Right after a backslash that isn't escaped itself, a run is escaped into text,
 *  so it moves in front of the backslash. Null when that would empty a comment. */
const outOfEscape = (
	doc: string,
	run: readonly Marker[],
	comments: ReadonlyMap<string, ParsedComment>,
): Change[] | null => {
	const first = run[0];
	const last = run[run.length - 1];
	if (!first || !last) return null;
	const keepsText = run.every((marker) => {
		const open = comments.get(marker.id)?.open;
		return !marker.closing || (!!open && open.to < first.from - 1);
	});
	if (!keepsText) return null;
	return [{ from: first.from - 1, to: last.to, insert: doc.slice(first.from, last.to) + "\\" }];
};

/** Past an indented code line's indentation, a marker is in the code and shows as
 *  text, so a run there only moves when it's all closers that can go back to the
 *  text they close on. Openers stay where they are, which hides them as before. */
const offCodeLine = (
	doc: string,
	run: readonly Marker[],
	line: TextRange,
	comments: ReadonlyMap<string, ParsedComment>,
): Change[] | null => {
	const first = run[0];
	const last = run[run.length - 1];
	const back = endOfTextBefore(doc, 0, line.from);
	if (!first || !last || back === null) return null;
	const closesBack = run.every((marker) => {
		const open = comments.get(marker.id)?.open;
		return marker.closing && !!open && open.to < back;
	});
	if (!closesBack) return null;
	return [
		{ from: back, to: back, insert: doc.slice(first.from, last.to) },
		{ from: first.from, to: last.to, insert: "" },
	];
};

/** Move a run off a rule or underline: its openers on to the text after it, and its
 *  closers back to the text before it. Null when either would empty a comment. */
const offRule = (
	doc: string,
	run: readonly Marker[],
	line: TextRange,
	comments: ReadonlyMap<string, ParsedComment>,
): Change[] | null => {
	const first = run[0];
	const last = run[run.length - 1];
	if (!first || !last) return null;
	const openers = run.filter((marker) => !marker.closing);
	const closers = run.filter((marker) => marker.closing);
	const ahead = openers.length > 0 ? nextTextStart(doc, line.to, true) : null;
	const back = closers.length > 0 ? endOfPlainTextBefore(doc, 0, line.from) : null;
	const opensAhead = openers.every((marker) => {
		const close = comments.get(marker.id)?.close;
		return ahead !== null && !!close && close.from > ahead;
	});
	const closesBack = closers.every((marker) => {
		const open = comments.get(marker.id)?.open;
		return back !== null && !!open && open.to < back;
	});
	if (!opensAhead || !closesBack) return null;
	const textOf = (markers: readonly Marker[]): string =>
		markers.map((marker) => doc.slice(marker.from, marker.to)).join("");
	const changes: Change[] = [{ from: first.from, to: last.to, insert: "" }];
	if (ahead !== null) {
		const guard = needsMarkerGuard(doc, ahead) ? MARKER_GUARD : "";
		changes.push({ from: ahead, to: ahead, insert: guard + textOf(openers) });
	}
	if (back !== null) changes.push({ from: back, to: back, insert: textOf(closers) });
	return changes;
};

const lineRepairs = (doc: string, parsed?: readonly ParsedComment[]): RunRepair[] => {
	const comments = parsed ?? parseComments(doc);
	const runs = markerRuns(anchorMarkers(comments));
	if (runs.length === 0) return [];
	const byId = new Map(comments.map((comment) => [comment.id, comment]));
	// Finding the tables and code blocks scans the whole document, so only do it
	// once a run is actually at the start of a line.
	let rows: ((lineFrom: number) => boolean) | null = null;
	let code: ((lineFrom: number) => boolean) | null = null;
	const bodyRow = (lineFrom: number): boolean => (rows ??= tableBodyRows(doc))(lineFrom);
	const codeLine = (lineFrom: number): boolean => (code ??= indentedCodeLines(doc))(lineFrom);
	return runs.flatMap((run) => {
		const changes = repairRun(doc, run, byId, bodyRow, codeLine);
		return changes ? [{ ids: run.map((marker) => marker.id), changes }] : [];
	});
};

/** Ids whose markers are stopping a line from rendering as written. */
export const brokenLineAnchors = (doc: string, parsed?: readonly ParsedComment[]): Set<string> => {
	return new Set(lineRepairs(doc, parsed).flatMap((repair) => repair.ids));
};

/**
 * Guard or move every run of markers breaking its line. `only` limits it to runs
 * holding one of those comments' markers; without it, the whole document.
 *
 * A run whose edits would touch one in `around`, or one an earlier run already
 * makes, is left for the next repair. It's kept or left whole: moving a closer
 * back is two edits, and making only the first deletes the closer outright.
 */
export const computeRepairLineAnchors = (
	doc: string,
	only?: ReadonlySet<string>,
	around: readonly Change[] = [],
): Result<Change[], string> => {
	const kept = lineRepairs(doc)
		.filter((repair) => !only || repair.ids.some((id) => only.has(id)))
		.reduce<Change[]>(
			(taken, repair) => {
				const clear = repair.changes.every((change) => taken.every((other) => apart(change, other)));
				return clear ? [...taken, ...repair.changes] : taken;
			},
			[...around],
		);
	return Result.ok(kept.slice(around.length).sort((a, b) => a.from - b.from));
};

/** Two edits that neither overlap nor touch. */
const apart = (a: Change, b: Change): boolean => a.to < b.from || a.from > b.to;
