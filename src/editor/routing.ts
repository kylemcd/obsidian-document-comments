import { App, MarkdownView, TFile } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { Change } from "./edits";
import { addComment, insertCommentInFile, processFileEdit } from "./commands";

/** The live CodeMirror view editing `file`, if it's open in a non-preview pane.
 *  Prefer this for edits: they join the editor's undo history and see its unsaved
 *  buffer, instead of racing the editor's autosave through a disk write. */
export const editorViewForFile = (app: App, file: TFile): EditorView | null => {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const v = leaf.view;
		if (v instanceof MarkdownView && v.file === file && v.getMode() !== "preview") {
			const cm = (v.editor as unknown as { cm?: unknown }).cm;
			if (cm instanceof EditorView) return cm;
		}
	}
	return null;
};

/** Apply a computed comment edit to `file`, preferring the open editor (undo
 *  history + unsaved buffer) and falling back to a direct file write. Ok carries
 *  the resulting document text so the caller can refresh from it. */
export const applyCommentEdit = async (
	app: App,
	file: TFile,
	compute: (doc: string) => Result<Change[], string>,
): Promise<Result<string, string>> => {
	const cm = editorViewForFile(app, file);
	if (cm) {
		return compute(cm.state.doc.toString()).map((changes) => {
			cm.dispatch({ changes });
			return cm.state.doc.toString();
		});
	}
	return processFileEdit(app, file, compute);
};

/** Insert a brand-new comment, preferring the open editor and falling back to a
 *  disk write. Ok carries the new comment id. `expected` is the originally
 *  selected text — the write is refused if the offsets no longer point at it. */
export const insertComment = async (
	app: App,
	file: TFile,
	from: number,
	to: number,
	text: string,
	author: string,
	expected?: string,
): Promise<Result<string, string>> => {
	const cm = editorViewForFile(app, file);
	if (cm) return addComment(cm, from, to, text, author, expected);
	return insertCommentInFile(app, file, from, to, text, author, expected);
};
