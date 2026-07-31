import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { TextRange } from "../format/types";

/** A pending comment range. A target id keeps an existing empty comment stable
 *  if another pane or Sync changes it before submission. */
export type Draft = TextRange & { targetHighlightId?: string };

export const setDraft = StateEffect.define<Draft>();
export const clearDraft = StateEffect.define<null>();

// Defined BEFORE draftField: newer CodeMirror evaluates a field's `provide`
// eagerly inside StateField.define (at module load), so anything it references
// must already be initialized — a `const` declared after the field is still in
// its temporal dead zone and throws, nulling the decoration provider.
const draftDecorations = (draft: Draft | null): DecorationSet => {
	if (!draft || draft.to <= draft.from) return Decoration.none;
	return Decoration.set([Decoration.mark({ class: "doc-comment-span dc-draft" }).range(draft.from, draft.to)]);
};

/**
 * Holds a pending "new comment" range while the user composes it in the margin —
 * a transient draft that isn't written to the document until they submit. The
 * range maps through edits, and provides a highlight over the text being commented.
 */
export const draftField = StateField.define<Draft | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setDraft)) return { ...e.value };
			if (e.is(clearDraft)) return null;
		}
		if (value && tr.docChanged) {
			const from = tr.changes.mapPos(value.from, 1);
			const to = tr.changes.mapPos(value.to, -1);
			return to > from ? { ...value, from, to } : null;
		}
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, draftDecorations),
});
