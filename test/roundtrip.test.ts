import { describe, expect, it } from "vitest";
import { parseComments } from "../src/format/parse";
import { closeMarker, openMarker, serializeBody } from "../src/format/serialize";
import { escapeText, splitReactionAuthors, unescapeText } from "../src/format/escape";
import { CommentData } from "../src/format/types";

const wrap = (id: string, body: string): string => openMarker(id) + "anchor" + closeMarker(id) + "\n" + body;

const roundtrip = (data: CommentData): CommentData => {
	const c = parseComments(wrap("t1", serializeBody("t1", data)))[0]!;
	return {
		author: c.author,
		createdAt: c.createdAt,
		status: c.status,
		quote: c.quote,
		thread: c.thread,
		reactions: c.reactions,
	};
};

const base = (over: Partial<CommentData>): CommentData => ({ status: "open", thread: [], reactions: [], ...over });

describe("body round-trip fidelity", () => {
	it("preserves multi-line text with a colon continuation line", () => {
		const data = base({ thread: [{ author: "kyle", text: "line one\nnote: this part matters" }] });
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("preserves multi-line text with a +emoji continuation line", () => {
		const data = base({ thread: [{ author: "kyle", text: "agreed\n+1 from me too" }] });
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("preserves blank lines inside multi-line text", () => {
		const data = base({ thread: [{ author: "kyle", text: "para one\n\npara two" }] });
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("preserves trailing whitespace inside text", () => {
		const data = base({ thread: [{ author: "kyle", text: "keep  inner  and trailing   " }] });
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("preserves a literal backslash sequence in text", () => {
		const data = base({ thread: [{ author: "kyle", text: "a path C:\\Users and a \\n literal" }] });
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("keeps a --> in the quote from ending the comment block early", () => {
		const data = base({ quote: "state A --> state B", thread: [{ author: "me", text: "hi" }] });
		const doc = wrap("t1", serializeBody("t1", data));
		// Only the structural markers may contain `-->`: open + close on the anchor
		// line, and the single body terminator. The quote's arrow must be broken.
		expect(doc.match(/-->/g)!.length).toBe(3);
		expect(roundtrip(data).thread).toEqual(data.thread);
	});

	it("keeps a --> in an author name from ending the block early", () => {
		const data = base({ author: "a-->b", thread: [{ author: "a-->b", text: "hi" }] });
		const c = parseComments(wrap("t1", serializeBody("t1", data)))[0]!;
		expect(c.thread[0]!.text).toBe("hi");
	});

	it("preserves a reaction author containing a comma", () => {
		const data = base({
			thread: [{ author: "me", text: "x" }],
			reactions: [{ emoji: "👍", authors: ["Doe, Jane", "sam"] }],
		});
		expect(roundtrip(data).reactions).toEqual(data.reactions);
	});

	it("round-trips through a CRLF document", () => {
		const data = base({ thread: [{ author: "kyle", text: "hello there" }] });
		const doc = wrap("t1", serializeBody("t1", data)).replace(/\n/g, "\r\n");
		expect(parseComments(doc)[0]!.thread).toEqual(data.thread);
	});
});

describe("escape primitives", () => {
	it("escapeText/unescapeText are inverse for arbitrary content", () => {
		for (const s of ["plain", "a\nb", "a\\b", "a\\nb", "trailing  ", "\r\n", "mix \\ and \n and \\n"]) {
			expect(unescapeText(escapeText(s))).toBe(s);
		}
	});

	it("splitReactionAuthors splits only on unescaped commas", () => {
		expect(splitReactionAuthors("a, b, c")).toEqual(["a", "b", "c"]);
		expect(splitReactionAuthors("Doe\\, Jane, sam")).toEqual(["Doe, Jane", "sam"]);
	});
});
