import {
	EditorSelection,
	EditorState,
	findClusterBreak,
	Range,
	RangeSet,
	StateField,
	Transaction,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";
import { commentPreview } from "../format/preview";

export type CommentFieldValue = {
	comments: ParsedComment[];
	decorations: DecorationSet;
	/** Hidden marker/body ranges, exposed as atomic so the caret skips over them. */
	atomic: RangeSet<Decoration>;
};

const HIDE = Decoration.replace({});

class SpaceWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		// Obsidian's createSpan auto-appends to the receiver; detach it so we hand
		// CodeMirror a free-standing node to place itself.
		const span = view.dom.createSpan({
			cls: "dc-comment-boundary-space",
			text: " ",
			attr: { "aria-hidden": "true" },
		});
		span.remove();
		return span;
	}
}

const HIDE_AS_SPACE = Decoration.replace({ widget: new SpaceWidget() });

class MarkerWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		// createSpan auto-appends; detach so CodeMirror receives a free node to place.
		const span = view.dom.createSpan({
			cls: "dc-comment-marker",
			text: "\u200b",
			attr: { "aria-hidden": "true" },
		});
		span.remove();
		return span;
	}
}

/**
 * Arrow-key handling around hidden markers. Atomic ranges already skip the marker
 * interior; this plugin makes a single Left/Right press land on the far side of a
 * marker (and its borrowed space) in one step, and extends a shift-selection the
 * same way, so the caret never appears to stall on an invisible marker.
 */
const markerNavigationPlugin = (field: StateField<CommentFieldValue>) => {
	const move = (view: EditorView, forward: boolean, extend: boolean): boolean => {
		const value = view.state.field(field, false);
		if (!value || (!extend && view.state.selection.ranges.some((range) => !range.empty))) return false;

		const doc = view.state.doc;
		const markers = value.comments.flatMap((comment) => {
			const result: Array<{ from: number; to: number }> = [];
			if (comment.open && doc.sliceString(comment.open.from - 1, comment.open.from) !== " ") {
				result.push(comment.open);
			}
			if (comment.close && doc.sliceString(comment.close.to, comment.close.to + 1) !== " ") {
				result.push(comment.close);
			}
			return result;
		});
		const entering = (head: number) =>
			markers.find((marker) => (forward ? marker.from === head : marker.to === head));
		const leaving = (head: number) =>
			markers.find((marker) => (forward ? marker.to === head : marker.from === head));
		if (!view.state.selection.ranges.some((range) => entering(range.head) || leaving(range.head))) {
			return false;
		}

		const ranges = view.state.selection.ranges.map((range) => {
			const through = entering(range.head);
			let target: number;
			if (through) {
				target = forward ? through.to : through.from;
			} else if (leaving(range.head)) {
				const moved = view.moveByChar(range, forward).head;
				const movedInDirection = forward ? moved > range.head : moved < range.head;
				target = movedInDirection ? moved : findClusterBreak(doc.toString(), range.head, forward);
			} else {
				target = view.moveByChar(range, forward).head;
			}
			return extend
				? EditorSelection.range(
						range.anchor,
						target,
						range.goalColumn,
						range.bidiLevel ?? undefined,
						range.assoc,
					)
				: EditorSelection.cursor(target, range.assoc, range.bidiLevel ?? undefined, range.goalColumn);
		});
		view.dispatch({
			selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
			scrollIntoView: true,
			userEvent: "select",
		});
		return true;
	};

	return ViewPlugin.define((view) => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.altKey || event.ctrlKey) return;
			const forward = event.key === "ArrowRight";
			if (!forward && event.key !== "ArrowLeft") return;
			if (!move(view, forward, event.shiftKey)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		view.contentDOM.addEventListener("keydown", onKeyDown, true);
		return {
			destroy: () => view.contentDOM.removeEventListener("keydown", onKeyDown, true),
		};
	});
};

/**
 * Parses the document into comments and derives the in-text decorations:
 * hide the markers + body blocks, highlight each anchored span.
 */
export const commentField = StateField.define<CommentFieldValue>({
	create(state) {
		return compute(state);
	},
	update(value, tr) {
		// A no-space marker is revealed when the selection reaches it, then hidden
		// again after the selection leaves. Selection-only transactions therefore
		// have to rebuild the marker decorations too.
		return tr.docChanged || tr.selection !== undefined ? compute(tr.state) : value;
	},
	provide: (f) => [
		EditorView.decorations.from(f, (v) => v.decorations),
		EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
		EditorState.changeFilter.of((tr) => protectMarkersFromUserEdits(tr, f)),
		EditorState.transactionFilter.of((tr) => snapSelectionOutOfMarkers(tr, f)),
		markerNavigationPlugin(f),
	],
});

export const getComments = (state: EditorState): ParsedComment[] => {
	return state.field(commentField, false)?.comments ?? [];
};

const compute = (state: EditorState): CommentFieldValue => {
	const text = state.doc.toString();
	const comments = parseComments(text);

	const decoRanges: Range<Decoration>[] = [];
	const hideRanges: Range<Decoration>[] = [];

	const addHide = (from: number, to: number, decoration = HIDE) => {
		if (to <= from) return;
		const range = decoration.range(from, to);
		decoRanges.push(range);
		hideRanges.push(range);
	};
	// Every marker's end offset, so an opener won't borrow a space a neighboring
	// closer already claimed. Two comments separated by a single space
	// (`…<!--/c:a--> <!--c:b-->…`) both want that space — the closer via "after",
	// the opener via "before" — and the overlapping replace/atomic ranges left no
	// caret position between the comments and rendered a double-width space.
	const markerEnds = new Set<number>();
	for (const c of comments) {
		if (c.open) markerEnds.add(c.open.to);
		if (c.close) markerEnds.add(c.close.to);
	}

	const addMarker = (marker: { from: number; to: number }, outside: "before" | "after") => {
		const hasOutsideSpace =
			outside === "before"
				? text.charAt(marker.from - 1) === " " && !markerEnds.has(marker.from - 1)
				: text.charAt(marker.to) === " ";
		if (hasOutsideSpace) {
			// Keep the marker invisible while giving its two legal caret endpoints
			// the same visual geometry as an ordinary source space. Only borrow the
			// space outside the anchor: before an opener, after a closer.
			addHide(
				marker.from - (outside === "before" ? 1 : 0),
				marker.to + (outside === "after" ? 1 : 0),
				HIDE_AS_SPACE,
			);
		} else if (selectionTouches(state, marker.from, marker.to)) {
			// With no adjacent outside space, give the replacement a tiny invisible
			// geometry shim so CodeMirror can distinguish its two caret endpoints.
			// Never reveal the raw marker: it can be long enough to wrap a table cell.
			addHide(marker.from, marker.to, Decoration.replace({ widget: new MarkerWidget() }));
		} else {
			addHide(marker.from, marker.to);
		}
	};

	for (const c of comments) {
		if (c.open) addMarker(c.open, "before");
		if (c.close) addMarker(c.close, "after");
		if (c.body) {
			// Swallow the newline before the body so its line disappears cleanly.
			let from = c.body.from;
			if (from > 0 && text.charCodeAt(from - 1) === 10 /* \n */) from -= 1;
			addHide(from, c.body.to);
		}
		const r = anchorRange(c);
		if (r && r.to > r.from) {
			// A mark decoration paints over live source text, so it shows in Source
			// mode and (via the Reading-view post-processor) in Reading view. It does
			// NOT show where Obsidian replaces the source with a widget — most notably
			// a Live-Preview table (.cm-table-widget, a self-contained nested editor):
			// the underlying text is hidden, so the highlight can't render there.
			const cls = c.status === "resolved" ? "doc-comment-span is-resolved" : "doc-comment-span";
			const attributes: Record<string, string> = { "data-cid": c.id };
			const preview = commentPreview(c);
			if (preview) attributes.title = preview;
			decoRanges.push(Decoration.mark({ class: cls, attributes }).range(r.from, r.to));
		}
	}

	// Build with sort=true so CodeMirror orders the ranges by its own
	// (from, startSide) comparator. Overlapping/nested comment anchors produce
	// overlapping mark + replace decorations; RangeSetBuilder trusts the caller's
	// ordering and can't take overlaps, yielding a corrupt set that crashed the
	// editor's span builder when such a note was opened.
	return {
		comments,
		decorations: Decoration.set(decoRanges, true),
		atomic: RangeSet.of(hideRanges, true),
	};
};

const selectionTouches = (state: EditorState, from: number, to: number): boolean => {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
};

/** Obsidian's own HTML-comment decorations can overlap ours and occasionally
 * leave a keyboard selection one source character inside a marker, most
 * notably for a closing marker at the end of a line. Once there, the caret can
 * get trapped. Normalize selection-only transactions back to the marker
 * endpoint in the direction the selection was moving. */
const snapSelectionOutOfMarkers = (
	tr: Transaction,
	field: StateField<CommentFieldValue>,
): Transaction | readonly [Transaction, { selection: EditorSelection }] => {
	if (tr.docChanged || tr.selection === undefined) return tr;
	const value = tr.startState.field(field, false);
	if (!value) return tr;

	const markers = value.comments.flatMap((comment) =>
		[comment.open, comment.close].filter((marker) => marker !== null),
	);
	let changed = false;
	const snap = (position: number, previous: number): number => {
		for (const marker of markers) {
			if (position <= marker.from || position >= marker.to) continue;
			changed = true;
			if (position > previous) return marker.to;
			if (position < previous) return marker.from;
			return position - marker.from < marker.to - position ? marker.from : marker.to;
		}
		return position;
	};

	const ranges = tr.newSelection.ranges.map((range, index) => {
		const previous = tr.startState.selection.ranges[index] ?? tr.startState.selection.main;
		return EditorSelection.range(
			snap(range.anchor, previous.anchor),
			snap(range.head, previous.head),
			range.goalColumn,
			range.bidiLevel ?? undefined,
			range.assoc,
		);
	});
	if (!changed) return tr;
	return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex) }];
};

/** Atomic deletion may target an entire marker-plus-space range. Keep the HTML
 * marker intact while allowing the user's surrounding text edit (including
 * deleting the borrowed space) to proceed. Plugin-generated transactions have
 * no input/delete/move user event, so normal comment actions and undo/redo are
 * left untouched. */
const protectMarkersFromUserEdits = (
	tr: Transaction,
	field: StateField<CommentFieldValue>,
): boolean | readonly number[] => {
	if (!tr.docChanged || (!tr.isUserEvent("input") && !tr.isUserEvent("delete") && !tr.isUserEvent("move"))) {
		return true;
	}
	const value = tr.startState.field(field, false);
	if (!value) return true;
	const protectedRanges: number[] = [];
	for (const comment of value.comments) {
		if (comment.open) protectedRanges.push(comment.open.from, comment.open.to);
		if (comment.close) protectedRanges.push(comment.close.from, comment.close.to);
		// The hidden body block is atomic too, so a forward-Delete at the end of the
		// anchored line expands over it and would silently destroy the whole thread
		// (the doc looks unchanged, since the body line is invisible). Protect it so
		// only the swallowed newline is removed and the lines join. Programmatic
		// comment deletion carries no user event and bypasses this filter entirely.
		if (comment.body) protectedRanges.push(comment.body.from, comment.body.to);
	}
	return protectedRanges.length > 0 ? protectedRanges : true;
};
