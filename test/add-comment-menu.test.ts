// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor, MarkdownFileInfo, Menu, MenuItem } from "obsidian";
import DocCommentsPlugin from "../src/main";
import { draftField } from "../src/editor/draft";

const NOTE = "| Field | Value |\n| --- | --- |\n| SKU | select this |";
const SELECTED = "select this";

type Surface = { view: EditorView; editor: Editor };

const surface = (doc: string, from: number, to: number): Surface => {
	const view = new EditorView({
		state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [draftField] }),
	});
	return { view, editor: { cm: view, somethingSelected: () => from !== to } as unknown as Editor };
};

const noteEditor = (): Surface => {
	const from = NOTE.indexOf(SELECTED);
	return surface(NOTE, from, from + SELECTED.length);
};

/** Runs the plugin's menu handler and returns the click of the item it added. */
const addCommentClick = (editor: Editor, info: MarkdownFileInfo): (() => void) | null => {
	const Plugin = DocCommentsPlugin as unknown as new () => DocCommentsPlugin;
	let click: (() => void) | null = null;
	const item: Record<string, unknown> = {
		setSection: () => item,
		setTitle: () => item,
		setIcon: () => item,
		onClick: (callback: () => void) => {
			click = callback;
			return item;
		},
	};
	const menu: Record<string, unknown> = {
		addItem: (configure: (menuItem: MenuItem) => void) => {
			configure(item as unknown as MenuItem);
			return menu;
		},
	};
	new Plugin().addCommentMenuItem(menu as unknown as Menu, editor, info);
	return click;
};

describe("Add comment in the editor's right-click menu", () => {
	// A table cell's menu passes the cell's own editor, which holds only the cell's
	// text and clips anything taller than the row (#117).
	test("from a table cell, the composer opens in the note's editor, on the same text", () => {
		const note = noteEditor();
		const cell = surface(SELECTED, 0, SELECTED.length);

		addCommentClick(cell.editor, { editor: note.editor } as unknown as MarkdownFileInfo)?.();

		const from = NOTE.indexOf(SELECTED);
		expect(note.view.state.field(draftField)).toMatchObject({ from, to: from + SELECTED.length });
		expect(cell.view.state.field(draftField)).toBeNull();
	});

	test("from the note's own editor, the composer opens there", () => {
		const note = noteEditor();

		addCommentClick(note.editor, { editor: note.editor } as unknown as MarkdownFileInfo)?.();

		expect(note.view.state.field(draftField)).not.toBeNull();
	});

	test("with an editor the menu's owner doesn't expose, the composer opens in the one clicked", () => {
		const note = noteEditor();

		addCommentClick(note.editor, {} as unknown as MarkdownFileInfo)?.();

		expect(note.view.state.field(draftField)).not.toBeNull();
	});

	test("with nothing selected, the menu has no Add comment item", () => {
		const note = surface(NOTE, 3, 3);

		expect(addCommentClick(note.editor, { editor: note.editor } as unknown as MarkdownFileInfo)).toBeNull();
	});
});
