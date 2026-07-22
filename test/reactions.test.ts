import { describe, it, expect } from "vitest";
import { parseComments } from "../src/format/parse";
import { serializeBody, openMarker, closeMarker } from "../src/format/serialize";
import { applyChanges, computeDeleteEntry, computeEditEntry, computeToggleReaction } from "../src/editor/edits";
import { CommentData } from "../src/format/types";

const wrap = (id: string, body: string): string => {
	return openMarker(id) + "anchor" + closeMarker(id) + "\n" + body;
};

const DATA: CommentData = {
	author: "kyle",
	createdAt: "2026-06-17T10:00",
	status: "open",
	quote: "x",
	thread: [
		{ author: "kyle", text: "first" },
		{ author: "sam", text: "second" },
	],
	reactions: [
		{ emoji: "👍", authors: ["kyle", "sam"] },
		{ emoji: "🎉", authors: ["mike"] },
	],
};

describe("reactions format", () => {
	it("round-trips reactions and thread", () => {
		const c = parseComments(wrap("r1", serializeBody("r1", DATA)))[0];
		expect(c.reactions).toEqual(DATA.reactions);
		expect(c.thread).toEqual(DATA.thread);
	});

	it("serializes reaction lines with a + prefix", () => {
		const body = serializeBody("r1", DATA);
		expect(body).toContain("+👍 kyle, sam");
		expect(body).toContain("+🎉 mike");
	});
});

describe("entry + reaction edits", () => {
	const base = wrap("r1", serializeBody("r1", { ...DATA, reactions: [] }));

	it("edits an entry's text without touching others", () => {
		const out = applyChanges(base, computeEditEntry(base, "r1", 1, "second edited").unwrap());
		const c = parseComments(out)[0];
		expect(c.thread).toHaveLength(2);
		expect(c.thread[0].text).toBe("first");
		expect(c.thread[1].text).toBe("second edited");
	});

	it("deletes a reply by index", () => {
		const c = parseComments(applyChanges(base, computeDeleteEntry(base, "r1", 1).unwrap()))[0];
		expect(c.thread).toHaveLength(1);
		expect(c.thread[0].text).toBe("first");
	});

	it("toggles a reaction on and off", () => {
		const on = applyChanges(base, computeToggleReaction(base, "r1", "👍", "kyle").unwrap());
		expect(parseComments(on)[0].reactions).toEqual([{ emoji: "👍", authors: ["kyle"] }]);
		const off = applyChanges(on, computeToggleReaction(on, "r1", "👍", "kyle").unwrap());
		expect(parseComments(off)[0].reactions).toEqual([]);
	});

	it("adds a second author to an existing reaction", () => {
		const a = applyChanges(base, computeToggleReaction(base, "r1", "❤️", "kyle").unwrap());
		const b = applyChanges(a, computeToggleReaction(a, "r1", "❤️", "sam").unwrap());
		expect(parseComments(b)[0].reactions).toEqual([{ emoji: "❤️", authors: ["kyle", "sam"] }]);
	});
});
