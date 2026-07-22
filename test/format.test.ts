import { describe, it, expect } from "vitest";
import { parseComments, anchorRange, isAnchored, isOrphan, existingIds, hasMarginAnchor } from "../src/format/parse";
import { serializeBody, openMarker, closeMarker } from "../src/format/serialize";
import { generateId } from "../src/format/ids";
import { CommentData } from "../src/format/types";

const CANONICAL = [
	"We should " + openMarker("k3f9") + "ship on Friday" + closeMarker("k3f9") + " regardless of the QA timeline.",
	'<!--co:k3f9 by:kyle at:2026-06-17T10:00 status:open quote:"ship on Friday"',
	"kyle: I thought we agreed Thursday?",
	"sam (2026-06-17T11:00): Thursday is better for QA.",
	"-->",
	"",
	"Next paragraph.",
].join("\n");

describe("parseComments", () => {
	it("parses the canonical example", () => {
		const comments = parseComments(CANONICAL);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c.id).toBe("k3f9");
		expect(c.author).toBe("kyle");
		expect(c.createdAt).toBe("2026-06-17T10:00");
		expect(c.status).toBe("open");
		expect(c.quote).toBe("ship on Friday");
		expect(c.thread).toHaveLength(2);
		expect(c.thread[0]).toMatchObject({ author: "kyle", text: "I thought we agreed Thursday?" });
		expect(c.thread[1]).toMatchObject({
			author: "sam",
			timestamp: "2026-06-17T11:00",
			text: "Thursday is better for QA.",
		});
	});

	it("resolves the anchor range to the highlighted text", () => {
		const c = parseComments(CANONICAL)[0];
		expect(isAnchored(c)).toBe(true);
		const r = anchorRange(c)!;
		expect(CANONICAL.slice(r.from, r.to)).toBe("ship on Friday");
	});

	it("parses a resolved status", () => {
		const doc = openMarker("a1") + "x" + closeMarker("a1") + "\n<!--co:a1 status:resolved\nme: done\n-->";
		expect(parseComments(doc)[0].status).toBe("resolved");
	});

	it("detects an orphan (body without anchor markers)", () => {
		const doc = "Some text with no markers.\n<!--co:zz9 status:open\nme: dangling\n-->";
		const c = parseComments(doc)[0];
		expect(isAnchored(c)).toBe(false);
		expect(isOrphan(c)).toBe(true);
		expect(hasMarginAnchor(c)).toBe(false);
	});

	it("only treats a complete anchored thread as a margin card", () => {
		const anchored = parseComments(CANONICAL)[0];
		const markerOnly = parseComments(openMarker("missing") + "text" + closeMarker("missing"))[0];
		expect(hasMarginAnchor(anchored)).toBe(true);
		expect(hasMarginAnchor(markerOnly)).toBe(false);
	});

	it("handles multiple and overlapping comments", () => {
		const doc =
			openMarker("aaa") +
			"the " +
			openMarker("bbb") +
			"quick brown" +
			closeMarker("bbb") +
			" fox" +
			closeMarker("aaa") +
			"\n<!--co:aaa status:open\nme: outer\n-->\n<!--co:bbb status:open\nme: inner\n-->";
		const comments = parseComments(doc);
		expect(comments.map((c) => c.id).sort()).toEqual(["aaa", "bbb"]);
		const aaa = comments.find((c) => c.id === "aaa")!;
		const bbb = comments.find((c) => c.id === "bbb")!;
		expect(doc.slice(anchorRange(aaa)!.from, anchorRange(aaa)!.to)).toBe(
			"the " + openMarker("bbb") + "quick brown" + closeMarker("bbb") + " fox",
		);
		expect(doc.slice(anchorRange(bbb)!.from, anchorRange(bbb)!.to)).toBe("quick brown");
	});

	it("collects existing ids", () => {
		expect([...existingIds(CANONICAL)]).toEqual(["k3f9"]);
	});

	it("ignores markers inside fenced code blocks", () => {
		const doc = [
			"Here is documentation:",
			"",
			"```markdown",
			openMarker("ex01") + "example span" + closeMarker("ex01"),
			"<!--co:ex01 status:open\nme: not a real comment\n-->",
			"```",
			"",
			"But this " + openMarker("real1") + "is real" + closeMarker("real1") + ".",
			"<!--co:real1 status:open\nme: real\n-->",
		].join("\n");
		const comments = parseComments(doc);
		expect(comments.map((c) => c.id)).toEqual(["real1"]);
	});

	it("ignores markers inside inline code", () => {
		const doc = "Use the `" + openMarker("inl01") + "` marker syntax to open a comment.";
		expect(parseComments(doc)).toHaveLength(0);
	});
});

describe("serializeBody round-trip", () => {
	it("survives serialize -> parse", () => {
		const data: CommentData = {
			author: "kyle",
			createdAt: "2026-06-17T10:00:00.000Z",
			status: "open",
			quote: "ship on Friday",
			thread: [
				{ author: "kyle", text: "I thought we agreed Thursday?" },
				{ author: "sam", timestamp: "2026-06-17T11:00:00.000Z", text: "Thursday is better for QA." },
			],
		};
		const doc = openMarker("k3f9") + "X" + closeMarker("k3f9") + "\n" + serializeBody("k3f9", data);
		const c = parseComments(doc)[0];
		expect(c.author).toBe(data.author);
		expect(c.createdAt).toBe(data.createdAt);
		expect(c.status).toBe(data.status);
		expect(c.quote).toBe(data.quote);
		expect(c.thread).toEqual(data.thread);
	});

	it("serializes a resolved, reply-only thread", () => {
		const data: CommentData = {
			author: "me",
			status: "resolved",
			thread: [{ author: "me", text: "ok" }],
		};
		const body = serializeBody("z1", data);
		expect(body.startsWith("<!--co:z1")).toBe(true);
		expect(body.endsWith("-->")).toBe(true);
		const c = parseComments("<!--c:z1-->q<!--/c:z1-->\n" + body)[0];
		expect(c.status).toBe("resolved");
		expect(c.thread).toEqual(data.thread);
	});
});

describe("generateId", () => {
	it("avoids collisions with existing ids", () => {
		const existing = new Set(["a", "b", "c"]);
		const id = generateId(existing);
		expect(existing.has(id)).toBe(false);
		expect(id).toMatch(/^[a-z0-9]+$/);
	});
});
