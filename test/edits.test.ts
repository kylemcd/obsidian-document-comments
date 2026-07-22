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

describe("computeAddComment code-block guard", () => {
	it("refuses a selection inside a fenced code block", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore";
		const from = doc.indexOf("spinner");
		const result = computeAddComment(doc, from, from + "spinner".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isErr()).toBe(true);
	});

	it("still allows a selection outside any fence", () => {
		const doc = "text\n```js\nconst spinner = 1;\n```\nmore prose here";
		const from = doc.indexOf("prose");
		const result = computeAddComment(doc, from, from + "prose".length, {
			id: "x",
			createdAt: "t",
			author: "a",
			text: "b",
		});
		expect(result.isOk()).toBe(true);
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
