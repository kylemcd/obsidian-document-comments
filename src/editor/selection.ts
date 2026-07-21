import type { Editor } from "obsidian";

export type EditorSelectionRange = { from: number; to: number };

/** Capture the current Obsidian editor selection in source offsets.
 *
 * Keeping the range separate from the later action matters for context menus:
 * opening/clicking the menu can move focus (especially inside table widgets),
 * while the Editor API still exposes the correct selection when the menu opens.
 */
export const editorSelectionRange = (editor: Editor): EditorSelectionRange | null => {
	const anchor = editor.posToOffset(editor.getCursor("anchor"));
	const head = editor.posToOffset(editor.getCursor("head"));
	const from = Math.min(anchor, head);
	const to = Math.max(anchor, head);
	return from === to ? null : { from, to };
};
