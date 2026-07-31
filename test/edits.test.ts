import { describe, it, expect } from "vitest";
import {
	applyChanges,
	blockEnd,
	computeAddComment,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
} from "../src/editor/edits";
import { anchorRange, parseComments } from "../src/format/parse";
import { closeMarker, openMarker } from "../src/format/serialize";

const DOC = "We should ship on Friday regardless of the QA timeline.\n\nNext paragraph.\n";
const FROM = DOC.indexOf("ship on Friday");
const TO = FROM + "ship on Friday".length;

const add = (): string => {
	const changes = computeAddComment(DOC, FROM, TO, {
		id: "k3f9",
		createdAt: "2026-06-17T10:00:00.000Z",
		author: "kyle",
		text: "I thought we agreed Thursday?",
	}).unwrap();
	return applyChanges(DOC, changes);
};

describe("computeAddComment", () => {
	it("wraps the selection and appends a body", () => {
		const out = add();
		const c = parseComments(out)[0];
		expect(c.id).toBe("k3f9");
		expect(c.author).toBe("kyle");
		expect(c.thread[0].text).toBe("I thought we agreed Thursday?");
		expect(out.slice(anchorRange(c)!.from, anchorRange(c)!.to)).toBe("ship on Friday");
	});

	it("places markers and body exactly", () => {
		const out = add();
		expect(out).toContain(openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9"));
		expect(out).toContain("QA timeline.\n<!--co:k3f9");
	});

	it("creates a highlight when the comment text is empty", () => {
		const out = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "2026-06-17T10:00:00.000Z",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const comment = parseComments(out)[0];

		expect(comment.thread).toEqual([]);
		expect(out.slice(anchorRange(comment)!.from, anchorRange(comment)!.to)).toBe("ship on Friday");
		expect(out).toContain('<!--co:h1 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"\n-->');
	});

	it("does not create a highlight when empty comments are disabled", () => {
		const changes = computeAddComment(DOC, FROM, TO, {
			id: "h1",
			createdAt: "t",
			author: "kyle",
			text: "",
			allowEmpty: false,
		}).unwrap();

		expect(changes).toEqual([]);
		expect(applyChanges(DOC, changes)).toBe(DOC);
	});

	it("keeps and converts an existing empty comment when new empty comments are disabled", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const range = anchorRange(parseComments(highlighted)[0])!;
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, range.from, range.to, {
				id: "unused",
				createdAt: "t2",
				author: "sam",
				text: "Can we ship Thursday?",
				allowEmpty: false,
			}).unwrap(),
		);
		const comments = parseComments(out);

		expect(comments).toHaveLength(1);
		expect(comments[0].id).toBe("h1");
		expect(comments[0].thread).toEqual([{ author: "sam", timestamp: "t2", text: "Can we ship Thursday?" }]);
		expect(out).not.toContain("unused");
	});

	it("removes an existing highlight with an empty submission even when empty comments are disabled", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const range = anchorRange(parseComments(highlighted)[0])!;
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, range.from, range.to, {
				id: "unused",
				createdAt: "t2",
				author: "sam",
				text: "",
				allowEmpty: false,
			}).unwrap(),
		);

		expect(out).toBe(DOC);
	});

	it("appends to the captured empty comment after another reply arrives", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const changed = applyChanges(
			highlighted,
			computeAppendReply(highlighted, "h1", { createdAt: "t2", author: "sam", text: "Remote reply" }).unwrap(),
		);
		const range = anchorRange(parseComments(changed)[0])!;
		const out = applyChanges(
			changed,
			computeAddComment(changed, range.from, range.to, {
				id: "unused",
				targetHighlightId: "h1",
				createdAt: "t3",
				author: "kyle",
				text: "Local reply",
			}).unwrap(),
		);
		const comments = parseComments(out);

		expect(comments).toHaveLength(1);
		expect(comments[0].id).toBe("h1");
		expect(comments[0].thread.map((entry) => entry.text)).toEqual(["Remote reply", "Local reply"]);
		expect(out).not.toContain("unused");
	});

	it("refuses stale removal after the captured empty comment receives a reply", () => {
		const highlighted = applyChanges(
			DOC,
			computeAddComment(DOC, FROM, TO, {
				id: "h1",
				createdAt: "t1",
				author: "kyle",
				text: "",
			}).unwrap(),
		);
		const changed = applyChanges(
			highlighted,
			computeAppendReply(highlighted, "h1", { createdAt: "t2", author: "sam", text: "Remote reply" }).unwrap(),
		);
		const range = anchorRange(parseComments(changed)[0])!;
		const result = computeAddComment(changed, range.from, range.to, {
			id: "unused",
			targetHighlightId: "h1",
			createdAt: "t3",
			author: "kyle",
			text: "",
			allowEmpty: true,
		});

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toContain("now has text");
		expect(parseComments(changed)).toHaveLength(1);
		expect(changed).not.toContain("unused");
	});

	it("keeps the prose intact once markup is stripped", () => {
		const out = add();
		expect(stripComments(out)).toContain("We should ship on Friday regardless of the QA timeline.");
	});

	it("errs for an empty selection", () => {
		const result = computeAddComment(DOC, FROM, FROM, { id: "x", createdAt: "t", author: "a", text: "b" });
		expect(result.isErr()).toBe(true);
	});

	it("places markers outside inline-code backticks", () => {
		const doc = "| What |\n| --- |\n| `Spinner` |";
		const from = doc.indexOf("Spinner");
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, from + "Spinner".length, {
				id: "code1",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);

		expect(out).toContain("<!--c:code1-->`Spinner`<!--/c:code1-->");
		expect(out).not.toContain("`<!--c:code1-->");
		const comment = parseComments(out).find((entry) => entry.id === "code1");
		expect(comment?.quote).toBe("`Spinner`");
		expect(out.slice(anchorRange(comment!)!.from, anchorRange(comment!)!.to)).toBe("`Spinner`");
	});

	it("converts an inline-code highlight when the code text is selected again", () => {
		const doc = "Use `Spinner` here.";
		const originalFrom = doc.indexOf("Spinner");
		const highlighted = applyChanges(
			doc,
			computeAddComment(doc, originalFrom, originalFrom + "Spinner".length, {
				id: "h3",
				createdAt: "t1",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const from = highlighted.indexOf("Spinner");
		const out = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, from + "Spinner".length, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "Use the shared component.",
			}).unwrap(),
		);

		expect(parseComments(out)).toHaveLength(1);
		expect(parseComments(out)[0].id).toBe("h3");
		expect(parseComments(out)[0].thread[0].text).toBe("Use the shared component.");
	});

	it("supports inline code delimited by multiple backticks", () => {
		const doc = "Use ``Spinner ` icon`` here.";
		const from = doc.indexOf("Spinner");
		const to = from + "Spinner ` icon".length;
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, to, {
				id: "code2",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);

		expect(out).toContain("<!--c:code2-->``Spinner ` icon``<!--/c:code2-->");
	});
});

describe("reply / resolve", () => {
	it("appends a reply", () => {
		const out = applyChanges(
			add(),
			computeAppendReply(add(), "k3f9", {
				createdAt: "2026-06-17T11:00:00.000Z",
				author: "sam",
				text: "Thursday is better",
			}).unwrap(),
		);
		const c = parseComments(out)[0];
		expect(c.thread).toHaveLength(2);
		expect(c.thread[1]).toMatchObject({ author: "sam", text: "Thursday is better" });
	});

	it("toggles resolved status", () => {
		const resolved = applyChanges(add(), computeSetResolved(add(), "k3f9", true).unwrap());
		expect(parseComments(resolved)[0].status).toBe("resolved");
		const reopened = applyChanges(resolved, computeSetResolved(resolved, "k3f9", false).unwrap());
		expect(parseComments(reopened)[0].status).toBe("open");
	});

	it("errs when the comment id is unknown", () => {
		expect(computeSetResolved(add(), "nope", true).isErr()).toBe(true);
	});
});

describe("computeAddComment in code blocks", () => {
	it("creates a code comment (block wrap + line target) for a selection inside a fence", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore";
		const from = doc.indexOf("spinner");
		const result = computeAddComment(doc, from, from + "spinner".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isOk()).toBe(true);
		const out = applyChanges(doc, result.unwrap());
		expect(out).toContain("<!--c:x-->\n```js");
		const c = parseComments(out).find((entry) => entry.id === "x")!;
		expect(c.codeLines).toEqual({ from: 0, to: 0 });
		expect(c.quote).toBe("const spinner = 1;");
	});

	it("still anchors a normal prose selection outside any fence", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore prose here";
		const from = doc.indexOf("prose");
		const result = computeAddComment(doc, from, from + "prose".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isOk()).toBe(true);
		expect(parseComments(applyChanges(doc, result.unwrap()))[0]!.codeLines).toBeUndefined();
	});

	it("creates a code highlight when the comment text is empty", () => {
		const doc = "```js\nconst spinner = 1;\n```";
		const from = doc.indexOf("const spinner");
		const out = applyChanges(
			doc,
			computeAddComment(doc, from, from + "const spinner = 1;".length, {
				id: "h2",
				createdAt: "t",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const comment = parseComments(out)[0];

		expect(comment.thread).toEqual([]);
		expect(comment.codeLines).toEqual({ from: 0, to: 0 });
	});

	it("converts and removes an existing code highlight through the same add flow", () => {
		const doc = "```js\nconst spinner = 1;\n```";
		const originalFrom = doc.indexOf("const spinner");
		const highlighted = applyChanges(
			doc,
			computeAddComment(doc, originalFrom, originalFrom + "const spinner = 1;".length, {
				id: "h2",
				createdAt: "t1",
				author: "a",
				text: "",
			}).unwrap(),
		);
		const from = highlighted.indexOf("const spinner");
		const to = from + "const spinner = 1;".length;
		const promoted = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, to, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "Explain this.",
			}).unwrap(),
		);
		expect(parseComments(promoted)).toHaveLength(1);
		expect(parseComments(promoted)[0].thread[0].text).toBe("Explain this.");

		const removed = applyChanges(
			highlighted,
			computeAddComment(highlighted, from, to, {
				id: "unused",
				createdAt: "t2",
				author: "b",
				text: "",
				allowEmpty: false,
			}).unwrap(),
		);
		expect(removed).toBe(doc);
	});
});

describe("computeDeleteComment", () => {
	it("round-trips back to the original document", () => {
		const out = add();
		const restored = applyChanges(out, computeDeleteComment(out, "k3f9").unwrap());
		expect(restored).toBe(DOC);
	});

	it("removes duplicated markers left by copy-pasting a commented span", () => {
		const out = add();
		// Simulate a paste: duplicate the anchor markers elsewhere in the doc.
		const anchor = openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9");
		const withDupe = out.replace("Next paragraph.", "Next paragraph. " + anchor);
		expect(withDupe.match(/<!--c:k3f9-->/g)!.length).toBe(2);
		const cleaned = applyChanges(withDupe, computeDeleteComment(withDupe, "k3f9").unwrap());
		expect(cleaned).not.toContain("k3f9");
	});

	// Deletes on the raw-file path (sidebar / Reading view) see the file's real line
	// endings. A code comment's own-line markers must take their whole CRLF terminator
	// with them, or a `\r\n` is left behind as a stray blank line around the block.
	it("round-trips a code-block comment on a CRLF file without leaving blank lines", () => {
		const base = "intro\n\n```js\nconst a = 1;\n```\n\noutro\n";
		const at = base.indexOf("const a = 1;");
		const withComment = applyChanges(
			base,
			computeAddComment(base, at, at + "const a = 1;".length, {
				id: "cc1",
				createdAt: "t",
				author: "a",
				text: "b",
			}).unwrap(),
		);
		const toCrlf = (s: string): string => s.replace(/\n/g, "\r\n");
		const crlf = toCrlf(withComment);
		const restored = applyChanges(crlf, computeDeleteComment(crlf, "cc1").unwrap());
		expect(restored).toBe(toCrlf(base));
	});
});

describe("malformed / boundary edit inputs", () => {
	it("errs on a reversed from/to being empty after the swap", () => {
		expect(computeAddComment(DOC, TO, FROM, { id: "x", createdAt: "t", author: "a", text: "b" }).isOk()).toBe(true);
		// A reversed zero-width range is still empty.
		expect(computeAddComment(DOC, FROM, FROM, { id: "x", createdAt: "t", author: "a", text: "b" }).isErr()).toBe(
			true,
		);
	});

	it("errs when the captured selection no longer matches (expected guard)", () => {
		const result = computeAddComment(DOC, FROM, TO, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
			expected: "something else entirely",
		});
		expect(result.isErr()).toBe(true);
	});

	it("errs on an out-of-range entry edit instead of a silent no-op write", () => {
		const out = add();
		expect(computeEditEntry(out, "k3f9", 99, "nope").isErr()).toBe(true);
		expect(computeDeleteEntry(out, "k3f9", -1).isErr()).toBe(true);
	});

	it("errs when replying to a comment that has no body", () => {
		const markerOnly = openMarker("m1") + "x" + closeMarker("m1");
		expect(computeSetResolved(markerOnly, "m1", true).isErr()).toBe(true);
		expect(computeAppendReply(markerOnly, "m1", { createdAt: "t", author: "a", text: "b" }).isErr()).toBe(true);
	});
});

describe("blockEnd", () => {
	it("stops at the blank line after a paragraph", () => {
		expect(blockEnd(DOC, TO)).toBe(DOC.indexOf("\n"));
	});
	it("returns doc length when no trailing newline", () => {
		const d = "single line no newline";
		expect(blockEnd(d, 3)).toBe(d.length);
	});
});

const stripComments = (s: string): string => {
	return s.replace(/<!--\/?co?:[A-Za-z0-9]+[\s\S]*?-->/g, "");
};
