import { describe, expect, test } from "vitest";
import type { Editor, EditorPosition } from "obsidian";
import { editorSelectionRange } from "../src/editor/selection";

const editorWith = (anchor: number, head: number): Editor =>
	({
		getCursor: (side: "anchor" | "head") => ({ line: 0, ch: side === "anchor" ? anchor : head }),
		posToOffset: (pos: EditorPosition) => pos.ch,
	}) as unknown as Editor;

describe("editorSelectionRange", () => {
	test("captures a forward selection", () => {
		expect(editorSelectionRange(editorWith(3, 9))).toEqual({ from: 3, to: 9 });
	});

	test("normalizes a backward selection", () => {
		expect(editorSelectionRange(editorWith(9, 3))).toEqual({ from: 3, to: 9 });
	});

	test("rejects an empty selection", () => {
		expect(editorSelectionRange(editorWith(4, 4))).toBeNull();
	});
});
