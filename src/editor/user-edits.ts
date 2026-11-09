import { ChangeSet, EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import { isCodeComment } from "../format/code-anchor";
import { MARKER_GUARD, needsMarkerGuard } from "../format/line-start";
import { CommentMarkup, anchorRange, commentMarkup, parseComments } from "../format/parse";
import { closeMarker, openMarker } from "../format/serialize";
import { ParsedComment, TextRange } from "../format/types";
import { blockEnd } from "./edits";

/**
 * How typing, deleting, cutting, pasting, and dragging treat the hidden comment
 * markup (#113).
 *
 * An edit that removes all of a comment's anchored text removes the comment too:
 * both markers and the thread, wherever the thread sits. An edit that removes only
 * part of it leaves the markers and thread alone, so the comment keeps the text
 * that's left. Copied text leaves the markup out, and pasting text that was cut or
 * dragged puts its comments back.
 */

type Edit = TextRange & { insert: string };

/** A user edit as CodeMirror made it, with where its insertion landed. */
type UserEdit = Edit & { inserted: TextRange };

/** A marker that copied text carried, by where it goes back once the text's markup is gone. */
type CarriedMarker = {
	id: string;
	closing: boolean;
	offset: number;
	/** The marker, with the line break it took along when it sat on a line of its own. */
	text: string;
	/** A code comment's marker sits on a line of its own, where it never needs a guard. */
	ownLine: boolean;
};

type CarriedBody = { text: string; code: boolean };

type Clip = {
	plain: string;
	markers: CarriedMarker[];
	bodies: Map<string, CarriedBody>;
};

/** What a copy or cut covered: CodeMirror's range, and where its text ends. A copy
 *  with nothing selected takes the cursor's line, and its cut takes the line break too. */
type Copied = TextRange & { textTo: number };

/** The last text copied, cut, or dragged out of any note. A paste finds it by its text. */
let lastClip: (Clip & { source: Text; cut: boolean }) | null = null;

/** A marker plus the guard in front of it, when it has one. The guard is invisible,
 *  so hiding, the caret, and deletion all have to treat the pair as the marker. */
export const withGuard = (doc: Text | string, marker: TextRange): TextRange => {
	const before =
		typeof doc === "string" ? doc.charAt(marker.from - 1) : doc.sliceString(marker.from - 1, marker.from);
	return marker.from > 0 && before === MARKER_GUARD ? { from: marker.from - 1, to: marker.to } : marker;
};

const isUserEdit = (tr: Transaction): boolean =>
	tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"));

const isPaste = (tr: Transaction): boolean =>
	tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop") || tr.isUserEvent("move.drop");

const overlaps = (a: TextRange, b: TextRange): boolean => a.from < b.to && b.from < a.to;

const byPosition = (a: TextRange, b: TextRange): number => a.from - b.from || a.to - b.to;

/** Whether an edit removes all of a comment's anchored text. A replacement only
 *  takes the comment when it spans both markers as well, so retyping just the
 *  anchored text keeps the comment on the new text. An empty anchor is already
 *  broken, and stays as it is. */
const takesComment = (doc: Text | string, edit: Edit, comment: ParsedComment): boolean => {
	const anchor = anchorRange(comment);
	if (!anchor || !comment.open || !comment.close || anchor.from === anchor.to) return false;
	if (edit.from > anchor.from || edit.to < anchor.to) return false;
	return !edit.insert || (edit.from <= withGuard(doc, comment.open).from && edit.to >= comment.close.to);
};

/** Whether an edit writes a comment's markers back itself. Obsidian saves an edit in
 *  a table cell by replacing the cell's whole text, markers included, as a user edit
 *  on the note, and the thread after the table has to survive it. */
const rewritesMarkers = (edit: Edit, comment: ParsedComment): boolean =>
	edit.insert.includes(openMarker(comment.id)) && edit.insert.includes(closeMarker(comment.id));

const piecesOf = (doc: Text, comment: ParsedComment): TextRange[] =>
	[comment.open && withGuard(doc, comment.open), comment.close && withGuard(doc, comment.close), comment.body].filter(
		(piece): piece is TextRange => !!piece,
	);

/** The kept markup an edit removed, put back into its result. A piece goes back
 *  after the edit's inserted text, unless the edit started inside it, when the
 *  rest of that piece goes back in front. */
const reinserts = (doc: Text, edits: readonly UserEdit[], holes: readonly TextRange[]): Edit[] =>
	edits.flatMap((edit) =>
		holes
			.filter((hole) => overlaps(hole, edit))
			.map((hole) => {
				const at = hole.from < edit.from ? edit.inserted.from : edit.inserted.to;
				const text = doc.sliceString(Math.max(hole.from, edit.from), Math.min(hole.to, edit.to));
				return { from: at, to: at, insert: text };
			}),
	);

/** What's left of the comments an edit takes: markers and threads outside its range.
 *  A thread goes with one of its line breaks, so no blank line stays behind, and a
 *  guard stays when a kept marker right after the removed one still needs it. */
const leftovers = (doc: Text, taken: ParsedComment[], kept: ParsedComment[], edits: Edit[]): TextRange[] => {
	const keptMarkers = new Set(kept.flatMap((comment) => [comment.open?.from, comment.close?.from]));
	const gone = (pos: number) => edits.some((edit) => edit.from <= pos && pos < edit.to);
	const marker = (range: TextRange) => (keptMarkers.has(range.to) ? range : withGuard(doc, range));
	const body = (range: TextRange): TextRange => {
		if (doc.sliceString(range.from - 1, range.from) === "\n" && !gone(range.from - 1)) {
			return { from: range.from - 1, to: range.to };
		}
		if (doc.sliceString(range.to, range.to + 1) === "\n" && !gone(range.to))
			return { from: range.from, to: range.to + 1 };
		return range;
	};
	return taken
		.flatMap((comment) => [
			comment.open && marker(comment.open),
			comment.close && marker(comment.close),
			comment.body && body(comment.body),
		])
		.filter(
			(piece): piece is TextRange =>
				!!piece && !edits.some((edit) => edit.from <= piece.from && piece.to <= edit.to),
		);
};

/** The changes that put cut comments back into pasted text: their markers first,
 *  then each thread at the end of its block, where adding the comment puts it.
 *  A comment comes back when the note doesn't have it, and the text was cut or this
 *  same edit moved it. Text that was only copied pastes without its comments. */
const restoreClip = (
	tr: Transaction,
	start: number,
	after: Text,
	moved: ReadonlySet<string>,
): [ChangeSet, ChangeSet] | null => {
	const clip = lastClip;
	if (!clip) return null;
	const afterText = after.toString();
	const present = new Set(parseComments(afterText).map((comment) => comment.id));
	const restored = clip.markers.filter((marker) => !present.has(marker.id) && (clip.cut || moved.has(marker.id)));
	if (restored.length === 0) return null;

	let shift = 0;
	const markers = restored.map((marker, index) => {
		const at = start + marker.offset;
		// Only the first of a run of markers needs the guard.
		const first = index === 0 || restored[index - 1]?.offset !== marker.offset;
		const guard = first && !marker.ownLine && needsMarkerGuard(afterText, at) ? MARKER_GUARD : "";
		const insert = guard + marker.text;
		const from = at + shift;
		shift += insert.length;
		return { ...marker, at, insert, from, to: from + insert.length };
	});
	const markerChanges = ChangeSet.of(
		markers.map(({ at, insert }) => ({ from: at, insert })),
		after.length,
		tr.startState.lineBreak,
	);
	const marked = markerChanges.apply(after);
	const markedText = marked.toString();
	const bodies = [...new Set(markers.map((marker) => marker.id))]
		.flatMap((id) => {
			const body = clip.bodies.get(id);
			const close = markers.find((marker) => marker.id === id && marker.closing);
			if (!body || !close) return [];
			return [{ from: body.code ? close.to : blockEnd(markedText, close.from), insert: "\n" + body.text }];
		})
		.sort((a, b) => a.from - b.from);
	return [markerChanges, ChangeSet.of(bodies, marked.length, tr.startState.lineBreak)];
};

/** The pasted text's selection once its comments are back. Mapped plainly, a caret
 *  at the end of the text would land in front of a closing marker put back there,
 *  inside the comment, so the text's edges are placed directly. */
const restoredSelection = (
	selection: EditorSelection,
	correction: ChangeSet,
	[markerChanges, bodyChanges]: [ChangeSet, ChangeSet],
	pasted: UserEdit,
	start: number,
): EditorSelection => {
	const map = (pos: number, assoc: -1 | 1) => bodyChanges.mapPos(markerChanges.mapPos(pos, assoc), -1);
	const place = (pos: number): number => {
		if (pos === pasted.inserted.to) return map(start + pasted.insert.length, 1);
		if (pos === pasted.inserted.from) return map(start, -1);
		return map(correction.mapPos(pos, -1), -1);
	};
	return EditorSelection.create(
		selection.ranges.map((range) => EditorSelection.range(place(range.anchor), place(range.head))),
		selection.mainIndex,
	);
};

/**
 * Applies the rules above to every typed, deleted, cut, pasted, or dragged change.
 * The user's transaction stays as CodeMirror made it, so its history and other
 * annotations carry over, with corrections applied after it. Programmatic changes
 * carry no such user event, so comment actions and undo/redo pass through.
 */
export const keepCommentsWhole = (
	tr: Transaction,
	comments: readonly ParsedComment[],
): Transaction | readonly (Transaction | TransactionSpec)[] => {
	if (!isUserEdit(tr)) return tr;
	const doc = tr.startState.doc;
	if (lastClip?.source === doc && tr.isUserEvent("delete.cut")) lastClip.cut = true;

	const edits: UserEdit[] = [];
	tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
		edits.push({ from, to, insert: inserted.toString(), inserted: { from: fromB, to: toB } });
	});
	const affected = comments.filter((comment) => !edits.some((edit) => rewritesMarkers(edit, comment)));
	const taken = affected.filter((comment) => edits.some((edit) => takesComment(doc, edit, comment)));
	const kept = affected.filter((comment) => !taken.includes(comment));
	const holes = kept
		.flatMap((comment) => piecesOf(doc, comment))
		.filter((piece) => edits.some((edit) => overlaps(piece, edit)))
		.sort(byPosition);
	const clip = lastClip;
	const pasted =
		clip && clip.markers.length > 0 && isPaste(tr)
			? edits.find((edit) => edit.insert === clip.plain || edit.insert === clip.plain + tr.startState.lineBreak)
			: undefined;
	if (taken.length === 0 && holes.length === 0 && !pasted) return tr;

	const removed = leftovers(doc, taken, kept, edits).map((piece) => ({
		from: tr.changes.mapPos(piece.from, 1),
		to: tr.changes.mapPos(piece.to, -1),
		insert: "",
	}));
	const correction = ChangeSet.of(
		[...reinserts(doc, edits, holes), ...removed].sort(byPosition),
		tr.newDoc.length,
		tr.startState.lineBreak,
	);
	const start = pasted ? correction.mapPos(pasted.inserted.from, 1) : 0;
	const restore = pasted
		? restoreClip(tr, start, correction.apply(tr.newDoc), new Set(taken.map((comment) => comment.id)))
		: null;
	if (correction.empty && !restore) return tr;

	const fixed = { changes: correction, sequential: true };
	if (!pasted || !restore) return [tr, fixed];
	const [markerChanges, bodyChanges] = restore;
	return [
		tr,
		fixed,
		{ changes: markerChanges, sequential: true },
		{
			changes: bodyChanges,
			sequential: true,
			selection: restoredSelection(tr.newSelection, correction, restore, pasted, start),
		},
	];
};

const copiedRanges = (state: EditorState): Copied[] => {
	const selected = state.selection.ranges.filter((range) => !range.empty);
	if (selected.length > 0) return selected.map(({ from, to }) => ({ from, to, textTo: to }));
	return state.selection.ranges
		.map((range) => state.doc.lineAt(range.from))
		.filter((line, index, lines) => index === 0 || line.number > (lines[index - 1]?.number ?? 0))
		.map((line) => ({ from: line.from, to: Math.min(state.doc.length, line.to + 1), textTo: line.to }));
};

/** Where a piece of markup ends once cut out of copied text, and the marker text to
 *  put back. A thread takes the line break before it, and a code comment's marker
 *  the line break that gives it a line of its own. A guard goes with its marker. */
const cutExtent = (
	source: string,
	piece: CommentMarkup,
	range: Copied,
	code: boolean,
): CommentMarkup & { text: string } => {
	const text = source.slice(piece.from, piece.to);
	const before = source.charAt(piece.from - 1);
	const after = source.charAt(piece.to);
	const breakBefore = piece.from - 1 >= range.from && before === "\n";
	const breakAfter = piece.to < range.textTo && after === "\n";
	if (piece.kind === "body") return { ...piece, from: breakBefore ? piece.from - 1 : piece.from, text };
	if (code && piece.kind === "open" && breakAfter && (piece.from === 0 || before === "\n")) {
		return { ...piece, to: piece.to + 1, text: text + "\n" };
	}
	if (code && piece.kind === "close" && breakBefore && (piece.to === source.length || after === "\n")) {
		return { ...piece, from: piece.from - 1, text: "\n" + text };
	}
	const guard = piece.from - 1 >= range.from && before === MARKER_GUARD;
	return { ...piece, from: guard ? piece.from - 1 : piece.from, text };
};

/** One copied range without its markup, and the comments it covers whole, with
 *  marker offsets counted from `base`. A covered comment whose marker sits just
 *  outside the range still gets it back, at that edge of the text. */
const captureRange = (
	source: string,
	range: Copied,
	markup: readonly CommentMarkup[],
	comments: readonly ParsedComment[],
	code: ReadonlySet<string>,
	base: number,
): Clip => {
	const covered = comments.filter((comment) => takesComment(source, { ...range, insert: "" }, comment));
	const coveredIds = new Set(covered.map((comment) => comment.id));
	const cuts = markup
		.filter((piece) => piece.from >= range.from && piece.to <= range.textTo)
		.map((piece) => cutExtent(source, piece, range, code.has(piece.id)));
	// One pass builds the text and the marker offsets into it together.
	const inside: CarriedMarker[] = [];
	let plain = "";
	let at = range.from;
	for (const cut of cuts) {
		plain += source.slice(at, cut.from);
		at = cut.to;
		if (cut.kind === "body" || !coveredIds.has(cut.id)) continue;
		inside.push({
			id: cut.id,
			closing: cut.kind === "close",
			offset: base + plain.length,
			text: cut.text,
			ownLine: code.has(cut.id),
		});
	}
	plain += source.slice(at, range.textTo);
	const outside = (comment: ParsedComment, closing: boolean, offset: number): CarriedMarker[] =>
		inside.some((marker) => marker.id === comment.id && marker.closing === closing)
			? []
			: [
					{
						id: comment.id,
						closing,
						offset,
						text: closing ? closeMarker(comment.id) : openMarker(comment.id),
						ownLine: code.has(comment.id),
					},
				];
	return {
		plain,
		markers: [
			...covered.flatMap((comment) => outside(comment, false, base)),
			...inside,
			...covered.flatMap((comment) => outside(comment, true, base + plain.length)),
		],
		bodies: new Map(
			covered.flatMap((comment) =>
				comment.body
					? [
							[
								comment.id,
								{ text: source.slice(comment.body.from, comment.body.to), code: code.has(comment.id) },
							],
						]
					: [],
			),
		),
	};
};

const capture = (source: string, ranges: readonly Copied[], comments: readonly ParsedComment[]): Clip => {
	const markup = commentMarkup(source);
	const code = new Set(comments.filter(isCodeComment).map((comment) => comment.id));
	return ranges.reduce<Clip>(
		(clip, range, index) => {
			const base = index === 0 ? 0 : clip.plain.length + 1;
			const part = captureRange(source, range, markup, comments, code, base);
			return {
				plain: index === 0 ? part.plain : `${clip.plain}\n${part.plain}`,
				markers: [...clip.markers, ...part.markers],
				bodies: new Map([...clip.bodies, ...part.bodies]),
			};
		},
		{ plain: "", markers: [], bodies: new Map() },
	);
};

/** What a copy, cut, or drag puts on the clipboard: the text without its comment
 *  markup, which no other app shows. The comments the text covers whole are kept
 *  aside, so a paste of the text, once cut, puts them back. */
export const clipboardText = (text: string, state: EditorState, comments: readonly ParsedComment[]): string => {
	const ranges = copiedRanges(state);
	const content = ranges.map((range) => state.sliceDoc(range.from, range.textTo)).join(state.lineBreak);
	if (content !== text) {
		// A dragged widget rather than the selection, or text another filter changed.
		lastClip = null;
		return capture(text, [{ from: 0, to: text.length, textTo: text.length }], parseComments(text)).plain;
	}
	lastClip = { ...capture(state.doc.toString(), ranges, comments), source: state.doc, cut: false };
	return lastClip.plain;
};
