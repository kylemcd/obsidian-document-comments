import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentField } from "../src/editor/state";
import { parseComments } from "../src/format/parse";

const body = (id: string, quote: string, text: string, extra = ""): string =>
	`<!--co:${id} by:me at:2026-10-21T09:49:50.322Z status:open quote:"${quote}"${extra}\nme: ${text}\n-->`;

const PARAGRAPH = `Intro <!--c:a1-->word<!--/c:a1--> end.\n${body("a1", "word", "hi")}`;
const DOC = `${PARAGRAPH}\n\nNext para.`;
const PARAGRAPH_END = DOC.indexOf(" end.") + 5;

const create = (doc: string, anchor = 0, head = anchor): EditorState =>
	EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [commentField] });

/** What CodeMirror puts on the clipboard: the selection, or the cursor's line when
 *  nothing is selected, run through the clipboard output filters. */
const copy = (state: EditorState): string => {
	const { from, to, empty } = state.selection.main;
	const text = empty ? state.doc.lineAt(from).text : state.sliceDoc(from, to);
	return state.facet(EditorView.clipboardOutputFilter).reduce((out, filter) => filter(out, state), text);
};

/** A cut the way CodeMirror makes it: copy first, then delete. */
const cut = (state: EditorState): { text: string; state: EditorState } => {
	const text = copy(state);
	const { from, to, empty } = state.selection.main;
	const line = state.doc.lineAt(from);
	const range = empty ? { from: line.from, to: Math.min(state.doc.length, line.to + 1) } : { from, to };
	return { text, state: state.update({ changes: range, userEvent: "delete.cut" }).state };
};

const paste = (state: EditorState, at: number, text: string): EditorState =>
	state.update({
		changes: { from: at, insert: text },
		selection: { anchor: at + text.length },
		userEvent: "input.paste",
	}).state;

const ids = (state: EditorState): string[] => parseComments(state.doc.toString()).map((comment) => comment.id);

describe("deleting commented text", () => {
	test("a deletion over a comment's whole text removes its thread, which sits outside the selection", () => {
		const state = create(DOC);
		const next = state.update({ changes: { from: 0, to: PARAGRAPH_END }, userEvent: "delete.selection" }).state;

		expect(next.doc.toString()).toBe("\n\nNext para.");
		expect(ids(next)).toEqual([]);
	});

	test("select all and delete leaves nothing behind", () => {
		const state = create(DOC);
		const next = state.update({ changes: { from: 0, to: DOC.length }, userEvent: "delete.selection" }).state;

		expect(next.doc.toString()).toBe("");
	});

	test("deleting exactly the anchored text removes the comment", () => {
		const state = create(DOC);
		const from = DOC.indexOf("word");
		const next = state.update({ changes: { from, to: from + 4 }, userEvent: "delete.selection" }).state;

		expect(next.doc.toString()).toBe("Intro  end.\n\nNext para.");
	});

	test("deleting part of the anchored text keeps the comment on what's left", () => {
		const state = create(DOC);
		const from = DOC.indexOf("word");
		const next = state.update({ changes: { from, to: from + 2 }, userEvent: "delete.selection" }).state;

		expect(next.doc.toString()).toBe(DOC.replace("-->word<", "-->rd<"));
	});

	test("retyping exactly the anchored text keeps the comment on the new text", () => {
		const state = create(DOC);
		const from = DOC.indexOf("word");
		const next = state.update({ changes: { from, to: from + 4, insert: "term" }, userEvent: "input.type" }).state;

		expect(next.doc.toString()).toBe(DOC.replace("-->word<", "-->term<"));
	});

	test("typing over a selection that holds a whole comment removes the comment", () => {
		const state = create(DOC);
		const next = state.update({
			changes: { from: 0, to: PARAGRAPH_END, insert: "New" },
			userEvent: "input.type",
		}).state;

		expect(next.doc.toString()).toBe("New\n\nNext para.");
	});

	// Regression: a replacement that started at a kept marker lost its inserted text.
	test("pasting over a selection that starts at a kept marker keeps the pasted text", () => {
		const doc = `\u200b<!--c:a1-->word<!--/c:a1--> end.\n${body("a1", "word", "hi")}`;
		const state = create(doc);
		const to = doc.indexOf("rd<");
		const next = state.update({ changes: { from: 0, to, insert: "Z" }, userEvent: "input.paste" }).state;

		expect(next.doc.toString()).toBe(`Z\u200b<!--c:a1-->rd<!--/c:a1--> end.\n${body("a1", "word", "hi")}`);
	});
});

// Obsidian saves an edit in a table cell by replacing the cell's whole text, markers
// included, as a user edit on the note. The thread sits after the table.
describe("editing a table cell", () => {
	const CELL = "<!--c:t1-->word<!--/c:t1--> here";
	const THREAD = body("t1", "word", "hi");
	const TABLE = `| A | B |\n| --- | --- |\n| x | ${CELL} |\n${THREAD}\n\nAfter.`;

	const saveCell = (text: string, userEvent: string): EditorState => {
		const from = TABLE.indexOf(CELL);
		return create(TABLE).update({ changes: { from, to: from + CELL.length, insert: text }, userEvent }).state;
	};

	test("typing elsewhere in the cell keeps the comment and its thread", () => {
		const next = saveCell("<!--c:t1-->word<!--/c:t1--> hereX", "input.type");

		expect(next.doc.toString()).toBe(TABLE.replace(" here |", " hereX |"));
		expect(ids(next)).toEqual(["t1"]);
	});

	test("deleting part of the commented text keeps the comment and its thread", () => {
		const next = saveCell("<!--c:t1-->wo<!--/c:t1--> here", "delete.backward");

		expect(next.doc.toString()).toBe(TABLE.replace(">word<", ">wo<"));
		expect(ids(next)).toEqual(["t1"]);
	});

	test("saving the cell without its markers still removes the comment and its thread", () => {
		const next = saveCell(" here", "delete.backward");

		expect(next.doc.toString()).toBe("| A | B |\n| --- | --- |\n| x |  here |\n\nAfter.");
		expect(ids(next)).toEqual([]);
	});
});

// The oldest Obsidian the manifest allows may ship a CodeMirror from before this
// facet existed (6.33). The field builds its extensions as soon as the module loads.
describe("on a CodeMirror without the clipboard filter", () => {
	const facet = Object.getOwnPropertyDescriptor(EditorView, "clipboardOutputFilter")!;

	afterEach(() => {
		Object.defineProperty(EditorView, "clipboardOutputFilter", facet);
		vi.resetModules();
	});

	test("the comment field still loads and deleting still follows the rules", async () => {
		Object.defineProperty(EditorView, "clipboardOutputFilter", { value: undefined, configurable: true });
		vi.resetModules();
		const { commentField: field } = await import("../src/editor/state");
		const state = EditorState.create({ doc: DOC, extensions: [field] });
		const from = DOC.indexOf("word");

		const next = state.update({ changes: { from, to: from + 4 }, userEvent: "delete.selection" }).state;

		expect(next.doc.toString()).toBe("Intro  end.\n\nNext para.");
	});
});

describe("copy, cut, and paste", () => {
	test("copied text leaves the comment markup out", () => {
		const doc = `\u200b<!--c:a1-->Word<!--/c:a1--> end.\n${body("a1", "Word", "hi")}\n\nNext para.`;
		const state = create(doc, 0, doc.indexOf("\n\nNext"));

		expect(copy(state)).toBe("Word end.");
	});

	test("cut and paste moves a comment, thread and all", () => {
		const { text, state } = cut(create(DOC, 0, PARAGRAPH_END));
		expect(state.doc.toString()).toBe("\n\nNext para.");

		const pasted = paste(state, state.doc.length, text);

		expect(pasted.doc.toString()).toBe(
			`\n\nNext para.Intro <!--c:a1-->word<!--/c:a1--> end.\n${body("a1", "word", "hi")}`,
		);
		// The caret follows the pasted text, not the thread put back after it.
		expect(pasted.selection.main.head).toBe(pasted.doc.toString().indexOf(" end.") + 5);
	});

	test("a cut comment pastes back once", () => {
		const { text, state } = cut(create(DOC, 0, PARAGRAPH_END));
		const once = paste(state, state.doc.length, text);
		const twice = paste(once, once.doc.length, text);

		expect(ids(twice)).toEqual(["a1"]);
		expect(twice.doc.toString().endsWith(`end.\n${body("a1", "word", "hi")}Intro word end.`)).toBe(true);
	});

	test("copied text pastes without its comment, in the same note or another", () => {
		const state = create(DOC, 0, PARAGRAPH_END);
		const text = copy(state);

		expect(paste(state, DOC.length, text).doc.toString()).toBe(`${DOC}Intro word end.`);
		expect(paste(create("Other. "), 7, text).doc.toString()).toBe("Other. Intro word end.");
	});

	test("cutting a line with nothing selected takes its comment, and pasting the line puts it back", () => {
		const { text, state } = cut(create(DOC, 3));
		expect(state.doc.toString()).toBe("\nNext para.");

		const pasted = state.update({
			changes: { from: 1, insert: `${text}\n` },
			selection: { anchor: 1 + text.length + 1 },
			userEvent: "input.paste",
		}).state;

		expect(pasted.doc.toString()).toBe(
			`\nIntro <!--c:a1-->word<!--/c:a1--> end.\nNext para.\n${body("a1", "word", "hi")}`,
		);
	});

	test("a cut comment pasted at the start of a line gets the guard that keeps the line text", () => {
		const doc = `Intro <!--c:a1-->word<!--/c:a1--> end.\n${body("a1", "word", "hi")}\n\nNext para.`;
		const from = doc.indexOf("<!--c:a1-->");
		const to = doc.indexOf(" end.");
		const { text, state } = cut(create(doc, from, to));
		expect(text).toBe("word");

		const at = state.doc.toString().indexOf("Next");
		const pasted = paste(state, at, text);

		expect(pasted.doc.toString()).toBe(
			`Intro  end.\n\n\u200b<!--c:a1-->word<!--/c:a1-->Next para.\n${body("a1", "word", "hi")}`,
		);
		expect(pasted.selection.main.head).toBe(pasted.doc.toString().indexOf("Next"));
	});

	test("dragging commented text moves its comment", () => {
		const state = create(DOC, 0, PARAGRAPH_END);
		const text = copy(state);
		const drop = DOC.length;
		const changes = state.changes([
			{ from: 0, to: PARAGRAPH_END },
			{ from: drop, insert: text },
		]);
		const moved = state.update({
			changes,
			selection: { anchor: changes.mapPos(drop, -1), head: changes.mapPos(drop, 1) },
			userEvent: "move.drop",
		}).state;

		expect(moved.doc.toString()).toBe(
			`\n\nNext para.Intro <!--c:a1-->word<!--/c:a1--> end.\n${body("a1", "word", "hi")}`,
		);
	});

	test("a code comment moves with its code block", () => {
		const code = "<!--c:k1-->\n```js\nlet a = 1;\n```\n<!--/c:k1-->";
		const doc = `Text.\n\n${code}\n${body("k1", "let a = 1;", "hi", " line:0")}\n\nEnd.`;
		const from = doc.indexOf("<!--c:k1-->");
		const to = doc.indexOf("<!--/c:k1-->") + "<!--/c:k1-->".length;
		const { text, state } = cut(create(doc, from, to));
		expect(text).toBe("```js\nlet a = 1;\n```");

		const typed = state.update({
			changes: { from: state.doc.length, insert: "\n\n" },
			userEvent: "input.type",
		}).state;
		const pasted = paste(typed, typed.doc.length, text);

		expect(pasted.doc.toString()).toBe(
			`Text.\n\n\n\nEnd.\n\n${code}\n${body("k1", "let a = 1;", "hi", " line:0")}`,
		);
	});
});
