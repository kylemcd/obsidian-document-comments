// @vitest-environment happy-dom
//
// Regression test for the editor extensions in a *live* EditorView. This is the
// only test that exercises StateField `provide` evaluation — which newer
// CodeMirror runs eagerly inside StateField.define — so it catches load-order
// bugs (e.g. a `provide` referencing a const declared later, a temporal-dead-zone
// crash) that pure-state and format tests miss. It fails outright if any editor
// extension throws while a note is opened.
import { beforeAll, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentField } from "../src/editor/state";
import { draftField, setDraft } from "../src/editor/draft";
import { commentConfig } from "../src/editor/config";
import { editorLayoutField } from "../src/editor/layout";

beforeAll(() => {
	// Obsidian adds DOM creation helpers at runtime; happy-dom does not. Mirror
	// the helper used by comment marker widgets so this remains a live EditorView
	// test instead of falling back to a production-only native DOM path.
	if (typeof HTMLElement.prototype.createSpan === "function") return;
	HTMLElement.prototype.createSpan = function (options = {}) {
		const span = this.ownerDocument.createElement("span");
		if (typeof options === "string") span.textContent = options;
		else {
			if (options.cls) span.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
			if (options.text !== undefined) span.textContent = options.text;
			for (const [name, value] of Object.entries(options.attr ?? {})) {
				if (value !== null) span.setAttribute(name, String(value));
			}
		}
		this.appendChild(span);
		return span;
	};
});

const pressArrow = (view: EditorView, key: "ArrowLeft" | "ArrowRight", shiftKey = false) => {
	view.contentDOM.dispatchEvent(
		new KeyboardEvent("keydown", {
			key,
			code: key,
			shiftKey,
			bubbles: true,
			cancelable: true,
		}),
	);
};

// Mirror the plugin's real editor extension set (minus the ViewPlugin, which needs
// DOM observers happy-dom doesn't fully provide). editorLayoutField has an eager
// `provide` too, so including it here is what guards layout.ts against a TDZ.
const config = commentConfig.of({
	author: () => "me",
	showComments: () => true,
	showResolved: () => true,
	sidebarOpen: () => false,
});

const open = (doc: string): string => {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({
		state: EditorState.create({ doc, extensions: [commentField, draftField, config, editorLayoutField] }),
		parent,
	});
	// A change forces the height map + decoration spans to rebuild — the path
	// that crashed in Obsidian.
	view.dispatch({ changes: { from: 0, insert: "x" } });
	view.requestMeasure();
	// The classes editorLayoutField pushed onto .cm-editor via editorAttributes.
	const className = view.dom.className;
	view.destroy();
	return className;
};

describe("editor extensions open every note without crashing", () => {
	test("plain note with no comments", () => {
		expect(() => open("Just plain text.\nNo comments here.\n")).not.toThrow();
	});

	test("note with a single comment", () => {
		const doc = [
			"Ship on <!--c:aaa-->Friday<!--/c:aaa--> regardless.",
			'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
			"me: sounds good",
			"-->",
			"",
		].join("\n");
		expect(() => open(doc)).not.toThrow();
	});

	test("note with overlapping / nested comments", () => {
		const doc = [
			"Already <!--c:zz1q--><!--c:xoua6-->resolved<!--/c:xoua6--><!--/c:zz1q--> here.",
			'<!--co:zz1q by:me at:2026-06-17T00:00:00.000Z status:resolved quote:"resolved"',
			"me: handled",
			"-->",
			'<!--co:xoua6 by:me at:2026-06-17T00:00:01.000Z status:open quote:"resolved"',
			"me: yooooo",
			"-->",
			"",
		].join("\n");
		expect(() => open(doc)).not.toThrow();
	});

	test("arrow keys cross an end-of-line marker and keep moving", () => {
		const doc = "text<!--/c:x-->\nnext";
		const markerFrom = doc.indexOf("<!--/c:x-->");
		const markerTo = markerFrom + "<!--/c:x-->".length;
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({
			state: EditorState.create({
				doc,
				selection: { anchor: markerFrom },
				extensions: [commentField],
			}),
			parent,
		});

		pressArrow(view, "ArrowRight");
		expect(view.state.selection.main.head).toBe(markerTo);
		pressArrow(view, "ArrowRight");
		expect(view.state.selection.main.head).toBe(markerTo + 1);

		view.dispatch({ selection: { anchor: markerTo } });
		pressArrow(view, "ArrowLeft");
		expect(view.state.selection.main.head).toBe(markerFrom);
		pressArrow(view, "ArrowLeft");
		expect(view.state.selection.main.head).toBe(markerFrom - 1);
		view.destroy();
	});

	// The layout no longer uses :has(); the stylesheet reaches the text column via
	// these classes on .cm-editor, so verify editorLayoutField actually applies them.
	test("editorLayoutField puts layout classes on .cm-editor", () => {
		const plain = open("Just plain text.\nNo comments here.\n");
		expect(plain).toContain("dc-highlights"); // master toggle is on
		expect(plain).not.toContain("dc-has"); // no comments → no reserved column

		const withComment = open(
			[
				"Ship on <!--c:aaa-->Friday<!--/c:aaa--> regardless.",
				'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
				"me: sounds good",
				"-->",
				"",
			].join("\n"),
		);
		expect(withComment).toContain("dc-has"); // a comment reserves the column
		expect(withComment).toContain("dc-highlights");
	});

	// Regression for issue #30: once every comment is resolved and resolved
	// comments are hidden, no card renders — so the column must not stay reserved.
	test("all comments resolved + resolved hidden does not reserve the column", () => {
		const hideResolved = commentConfig.of({
			author: () => "me",
			showComments: () => true,
			showResolved: () => false,
			sidebarOpen: () => false,
		});
		const openWith = (doc: string, cfg: typeof hideResolved): string => {
			const parent = document.createElement("div");
			document.body.appendChild(parent);
			const view = new EditorView({
				state: EditorState.create({ doc, extensions: [commentField, draftField, cfg, editorLayoutField] }),
				parent,
			});
			view.requestMeasure();
			const className = view.dom.className;
			view.destroy();
			return className;
		};
		const resolvedDoc = [
			"Ship on <!--c:aaa-->Friday<!--/c:aaa--> regardless.",
			'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:resolved quote:"Friday"',
			"me: done",
			"-->",
			"",
		].join("\n");
		// Sanity: with resolved shown, the (visible) resolved card still reserves the column.
		expect(openWith(resolvedDoc, config)).toContain("dc-has");
		// With resolved hidden, the card is display:none, so no column is reserved.
		expect(openWith(resolvedDoc, hideResolved)).not.toContain("dc-has");

		// Mixed: one open + one resolved comment, resolved hidden. The open card
		// still renders, so the column MUST stay reserved — guards the predicate
		// against being written as `.every(...)` instead of `.some(...)`.
		const mixedDoc = [
			"Ship on <!--c:aaa-->Friday<!--/c:aaa--> and <!--c:bbb-->Monday<!--/c:bbb--> too.",
			'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:resolved quote:"Friday"',
			"me: done",
			"-->",
			'<!--co:bbb by:me at:2026-06-17T00:00:01.000Z status:open quote:"Monday"',
			"me: still open",
			"-->",
			"",
		].join("\n");
		expect(openWith(mixedDoc, hideResolved)).toContain("dc-has");
	});

	// Regression for issue #15: opening the transient "new comment" composer must
	// NOT reserve the column. It used to toggle `dc-has`, which caps the sizer
	// width and reflows/re-centers the whole document every time you start (and
	// finish) a comment. The floating composer overlays the gutter instead.
	test("an open draft does not reserve the column (no reflow)", () => {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({
			state: EditorState.create({
				doc: "Just plain text.\nNo comments here.\n",
				extensions: [commentField, draftField, config, editorLayoutField],
			}),
			parent,
		});
		view.dispatch({ effects: setDraft.of({ from: 0, to: 4 }) });
		view.requestMeasure();
		const className = view.dom.className;
		view.destroy();
		expect(className).not.toContain("dc-has"); // draft is a floating overlay, no column reserved
		expect(className).toContain("dc-highlights"); // highlights still follow the master toggle
	});
});
