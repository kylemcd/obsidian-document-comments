import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { commentField } from "../src/editor/state";
import { parseComments } from "../src/format/parse";

// Two comments anchored on overlapping text — `xoua6` sits nested inside `zz1q`,
// both covering "resolved". This is the shape that crashed CodeMirror's
// decoration build (RangeSetBuilder can't take overlapping ranges).
const NESTED = [
	`Already <!--c:zz1q--><!--c:xoua6-->resolved<!--/c:xoua6--><!--/c:zz1q--> text here.`,
	`<!--co:zz1q by:kyle at:2026-06-17T09:00:00.000Z status:resolved quote:"resolved"`,
	`kyle: Handled.`,
	`-->`,
	`<!--co:xoua6 by:me at:2026-06-17T19:08:26.472Z status:open quote:"resolved"`,
	`me: yooooo`,
	`-->`,
].join("\n");

describe("commentField decorations", () => {
	test("overlapping/nested comment anchors build and map without crashing", () => {
		// EditorState.create runs compute(); .map() is what CodeMirror does to the
		// decoration set on setViewData — both must survive overlapping anchors.
		expect(() => {
			const state = EditorState.create({ doc: NESTED, extensions: [commentField] });
			const field = state.field(commentField);
			const { changes } = state.update({ changes: { from: 0, to: 0, insert: "" } });
			field.decorations.map(changes);
			field.atomic.map(changes);
		}).not.toThrow();
	});

	test("still highlights both overlapping comments", () => {
		const state = EditorState.create({ doc: NESTED, extensions: [commentField] });
		const cids: string[] = [];
		const cursor = state.field(commentField).decorations.iter();
		while (cursor.value) {
			const cid = cursor.value.spec?.attributes?.["data-cid"];
			if (cid) cids.push(cid);
			cursor.next();
		}
		expect(cids).toContain("zz1q");
		expect(cids).toContain("xoua6");
	});

	test("space-padded markers borrow only the space outside the anchor", () => {
		const doc = "some <!--c:x-->text<!--/c:x--> after";
		const state = EditorState.create({ doc, extensions: [commentField] });
		const comment = parseComments(doc)[0];
		const ranges: Array<[number, number]> = [];
		const cursor = state.field(commentField).atomic.iter();
		while (cursor.value) {
			ranges.push([cursor.from, cursor.to]);
			cursor.next();
		}

		expect(ranges).toContainEqual([comment.open!.from - 1, comment.open!.to]);
		expect(ranges).toContainEqual([comment.close!.from, comment.close!.to + 1]);
	});

	test("renders a visible atomic widget when the selection reaches a no-space marker", () => {
		const doc = "some<!--c:x-->text<!--/c:x-->after";
		const comment = parseComments(doc)[0];
		const start = EditorState.create({ doc, selection: { anchor: 1 }, extensions: [commentField] });
		const atOpen = start.update({ selection: { anchor: comment.open!.from } }).state;
		const hidden: Array<[number, number]> = [];
		const atomicCursor = atOpen.field(commentField).atomic.iter();
		while (atomicCursor.value) {
			hidden.push([atomicCursor.from, atomicCursor.to]);
			atomicCursor.next();
		}
		let openHasWidget = false;
		const decorationCursor = atOpen.field(commentField).decorations.iter();
		while (decorationCursor.value) {
			if (
				decorationCursor.from === comment.open!.from &&
				decorationCursor.to === comment.open!.to &&
				decorationCursor.value.spec.widget
			) {
				openHasWidget = true;
			}
			decorationCursor.next();
		}

		expect(hidden).toContainEqual([comment.open!.from, comment.open!.to]);
		expect(hidden).toContainEqual([comment.close!.from, comment.close!.to]);
		expect(openHasWidget).toBe(true);
	});

	test("snaps forward cursor movement out of a marker interior", () => {
		const doc = "text<!--/c:x-->\nnext";
		const comment = parseComments(doc)[0];
		const close = comment.close!;
		const state = EditorState.create({
			doc,
			selection: { anchor: close.from },
			extensions: [commentField],
		});
		const tr = state.update({
			selection: { anchor: close.to - 1 },
			userEvent: "select",
		});

		expect(tr.newSelection.main.head).toBe(close.to);
	});

	test("snaps backward cursor movement out of a marker interior", () => {
		const doc = "text<!--/c:x-->\nnext";
		const comment = parseComments(doc)[0];
		const close = comment.close!;
		const state = EditorState.create({
			doc,
			selection: { anchor: close.to },
			extensions: [commentField],
		});
		const tr = state.update({
			selection: { anchor: close.to - 1 },
			userEvent: "select",
		});

		expect(tr.newSelection.main.head).toBe(close.from);
	});

	test("user deletion removes a borrowed space without corrupting its marker", () => {
		const doc = "some <!--c:x-->text<!--/c:x--> after";
		const comment = parseComments(doc)[0];
		const state = EditorState.create({ doc, extensions: [commentField] });
		const tr = state.update({
			changes: { from: comment.open!.from - 1, to: comment.open!.to },
			userEvent: "delete.backward",
		});

		expect(tr.newDoc.toString()).toBe("some<!--c:x-->text<!--/c:x--> after");
	});

	test("forward deletion also preserves a closing marker", () => {
		const doc = "some <!--c:x-->text<!--/c:x--> after";
		const comment = parseComments(doc)[0];
		const state = EditorState.create({ doc, extensions: [commentField] });
		const tr = state.update({
			changes: { from: comment.close!.from, to: comment.close!.to + 1 },
			userEvent: "delete.forward",
		});

		expect(tr.newDoc.toString()).toBe("some <!--c:x-->text<!--/c:x-->after");
	});

	test("typing at a marker boundary remains a normal text edit", () => {
		const doc = "some <!--c:x-->text<!--/c:x--> after";
		const comment = parseComments(doc)[0];
		const state = EditorState.create({ doc, extensions: [commentField] });
		const tr = state.update({
			changes: { from: comment.open!.to, insert: "new " },
			userEvent: "input.type",
		});

		expect(tr.newDoc.toString()).toBe("some <!--c:x-->new text<!--/c:x--> after");
	});

	test("programmatic comment edits can still remove a marker", () => {
		const doc = "some <!--c:x-->text<!--/c:x--> after";
		const comment = parseComments(doc)[0];
		const state = EditorState.create({ doc, extensions: [commentField] });
		const tr = state.update({ changes: { from: comment.open!.from, to: comment.open!.to } });

		expect(tr.newDoc.toString()).toBe("some text<!--/c:x--> after");
	});
});
