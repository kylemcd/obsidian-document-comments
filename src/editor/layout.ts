import { EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentField } from "./state";
import { commentConfig } from "./config";
import { hasMarginAnchor } from "../format/parse";

// Defined ABOVE editorLayoutField: StateField.define evaluates `provide` EAGERLY
// at module load, and the provider arrow it builds references this helper. A
// `const` referenced before its definition line is in the temporal dead zone and
// throws ReferenceError — which would break every note. (Same trap as draft.ts.)
const editorLayoutClasses = (state: EditorState): string => {
	const cfg = state.facet(commentConfig);
	const fv = state.field(commentField, false);
	// `dc-has` mirrors the inline column: present only when persistent cards
	// actually render (comments shown, sidebar not hosting them, not mobile). It is
	// deliberately NOT tied to the transient draft composer — reserving the column
	// for a draft toggled the sizer's width cap on when a composer opened and off
	// when it closed, reflowing (and re-centering) the whole document on every new
	// comment (issue #15). The composer is a floating overlay, so with no cap it just
	// sits over the right-hand whitespace; the text only shifts once a card persists.
	const showInline = cfg.showComments() && !cfg.sidebarOpen() && !(cfg.isMobile?.() ?? false);
	// Only comments whose card actually renders reserve the column. A resolved
	// comment's card is `display:none` while resolved are hidden (dc-hide-resolved),
	// so counting it kept the column — and its reserved width — around with nothing
	// in it once every comment was resolved (issue #30). Mirror that visibility here.
	// The reading-view margin applies the same guard (src/reading/margin.ts).
	const hasColumn =
		showInline &&
		!!fv &&
		fv.comments.some((c) => hasMarginAnchor(c) && (cfg.showResolved() || c.status !== "resolved"));

	const classes: string[] = [];
	if (hasColumn) classes.push("dc-has");
	// Highlights follow the master toggle alone, so they persist while the sidebar
	// panel hosts the cards (dc-has off, dc-highlights on).
	if (cfg.showComments()) classes.push("dc-highlights");
	if (!cfg.showResolved()) classes.push("dc-hide-resolved");
	return classes.join(" ");
};

/**
 * Mirrors the layout/visibility state onto the `.cm-editor` element as plain
 * classes (`dc-has`, `dc-highlights`, `dc-hide-resolved`) so the stylesheet can
 * cap the text column and toggle highlights with ordinary descendant selectors —
 * no `:has()`. We route through CodeMirror's `editorAttributes` facet rather than
 * `classList` on `view.dom`, because CodeMirror owns that element's className and
 * rewrites it on reconfigure; a raw `classList.add` gets silently dropped (the
 * reason the layout used to key off a `:has()` of our own child element instead).
 *
 * The value recomputes on every transaction — including the empty `dispatch({})`
 * the plugin fires when a setting toggles — so the classes always track state.
 */
export const editorLayoutField = StateField.define<string>({
	create: editorLayoutClasses,
	update: (value, tr) => {
		const next = editorLayoutClasses(tr.state);
		return next === value ? value : next;
	},
	provide: (f) => EditorView.editorAttributes.from(f, (cls) => ({ class: cls })),
});
