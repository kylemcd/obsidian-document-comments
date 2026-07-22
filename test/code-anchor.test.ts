import { describe, expect, it } from "vitest";
import { applyChanges, computeAddComment, computeDeleteComment } from "../src/editor/edits";
import { parseComments, isAnchored } from "../src/format/parse";
import { codeSelectionTarget, resolveCodeAnchor } from "../src/format/code-anchor";
import { decodeCodeQuote, encodeCodeQuote } from "../src/format/escape";

const BLOCK = ["text before", "```js", "const a = 1;", "const b = 2;", "const c = 3;", "```", "text after"].join("\n");

const addCode = (doc: string, from: number, to: number, id = "cc1"): string =>
	applyChanges(doc, computeAddComment(doc, from, to, { id, createdAt: "t", author: "me", text: "look" }).unwrap());

describe("codeSelectionTarget", () => {
	it("snaps a mid-line selection to the whole line", () => {
		const from = BLOCK.indexOf("const b") + 2; // mid-word
		const to = from + 3;
		const target = codeSelectionTarget(BLOCK, from, to)!;
		expect(target.quote).toBe("const b = 2;");
		expect(target.codeLines).toEqual({ from: 1, to: 1 });
	});

	it("spans multiple whole lines", () => {
		const from = BLOCK.indexOf("const b") + 4;
		const to = BLOCK.indexOf("const c") + 4;
		const target = codeSelectionTarget(BLOCK, from, to)!;
		expect(target.quote).toBe("const b = 2;\nconst c = 3;");
		expect(target.codeLines).toEqual({ from: 1, to: 2 });
	});
});

describe("code comment creation + parse", () => {
	it("wraps the block on its own lines and stores line + quote", () => {
		const from = BLOCK.indexOf("const b");
		const out = addCode(BLOCK, from, from + "const b = 2;".length);
		// Markers on their own lines around the fence, body after.
		expect(out).toContain("<!--c:cc1-->\n```js");
		expect(out).toContain("```\n<!--/c:cc1-->");
		const c = parseComments(out).find((x) => x.id === "cc1")!;
		expect(isAnchored(c)).toBe(true);
		expect(c.codeLines).toEqual({ from: 1, to: 1 });
		expect(c.quote).toBe("const b = 2;");
	});

	it("resolves to the exact source range of the commented line", () => {
		const from = BLOCK.indexOf("const b");
		const out = addCode(BLOCK, from, from + "const b = 2;".length);
		const c = parseComments(out).find((x) => x.id === "cc1")!;
		const r = resolveCodeAnchor(out, c)!;
		expect(out.slice(r.from, r.to)).toBe("const b = 2;");
	});

	it("re-anchors by content when a line is inserted above it", () => {
		const from = BLOCK.indexOf("const b");
		const out = addCode(BLOCK, from, from + "const b = 2;".length);
		// Insert a new first line into the block content.
		const at = out.indexOf("const a = 1;");
		const edited = out.slice(0, at) + "const z = 0;\n" + out.slice(at);
		const c = parseComments(edited).find((x) => x.id === "cc1")!;
		const r = resolveCodeAnchor(edited, c)!;
		expect(edited.slice(r.from, r.to)).toBe("const b = 2;"); // followed the content, not the stale line index
	});

	it("deletes cleanly back to the original block (no blank lines left)", () => {
		const from = BLOCK.indexOf("const b");
		const out = addCode(BLOCK, from, from + "const b = 2;".length);
		const c = parseComments(out).find((x) => x.id === "cc1")!;
		const restored = applyChanges(out, computeDeleteComment(out, c.id).unwrap());
		expect(restored).toBe(BLOCK);
	});

	it("orphans (null) when the commented code itself changes", () => {
		const from = BLOCK.indexOf("const b");
		const out = addCode(BLOCK, from, from + "const b = 2;".length);
		const changed = out.replace("const b = 2;", "const b = 999;");
		const c = parseComments(changed).find((x) => x.id === "cc1")!;
		expect(resolveCodeAnchor(changed, c)).toBeNull();
	});

	it("preserves code containing quotes, newlines, and --> through the header", () => {
		const code = ["if (x) {", '  say("hi--> there");', "}"].join("\n");
		const doc = ["```", ...code.split("\n"), "```"].join("\n");
		const from = doc.indexOf('say("hi'); // select the middle line
		const out = addCode(doc, from, from + 5);
		const c = parseComments(out).find((x) => x.id === "cc1")!;
		expect(c.quote).toBe('  say("hi--> there");');
		// The body block must still terminate exactly once (its own -->).
		const bodyStart = out.indexOf("<!--co:cc1");
		expect(out.slice(bodyStart).match(/-->/g)!.length).toBe(1);
	});
});

describe("code-quote codec", () => {
	it("round-trips arbitrary code", () => {
		for (const s of ['a"b', "l1\nl2", "x-->y", "a\\b", 'mix "q"\nand -->\tend', "path\\n"]) {
			expect(decodeCodeQuote(encodeCodeQuote(s))).toBe(s);
		}
	});

	it('encoded form contains no raw ", newline, or -->', () => {
		const enc = encodeCodeQuote('a "b" c\n-->\nd');
		expect(enc).not.toContain('"');
		expect(enc).not.toContain("\n");
		expect(enc).not.toContain("-->");
	});
});
