import { EditorState, Range, RangeSet, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
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

/**
 * Parses the document into comments and derives the in-text decorations:
 * hide the markers + body blocks, highlight each anchored span.
 */
export const commentField = StateField.define<CommentFieldValue>({
	create(state) {
		return compute(state);
	},
	update(value, tr) {
		return tr.docChanged ? compute(tr.state) : value;
	},
	provide: (f) => [
		EditorView.decorations.from(f, (v) => v.decorations),
		EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
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

	const addHide = (from: number, to: number) => {
		if (to <= from) return;
		const range = HIDE.range(from, to);
		decoRanges.push(range);
		hideRanges.push(range);
	};

	for (const c of comments) {
		if (c.open) addHide(c.open.from, c.open.to);
		if (c.close) addHide(c.close.from, c.close.to);
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
