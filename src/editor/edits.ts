import { Result } from "better-result";
import { CommentData, ParsedComment, Reaction } from "../format/types";
import { parseComments } from "../format/parse";
import { closeMarker, openMarker, serializeBody } from "../format/serialize";

/** A document edit in original coordinates (matches CodeMirror's ChangeSpec shape). */
export type Change = {
	from: number;
	to: number;
	insert: string;
};

export type NewCommentInput = {
	id: string;
	createdAt: string;
	author: string;
	text: string;
};

/** Wrap [from,to] with anchor markers and append a body block after the block.
 *  Errs (rather than returning null) so the caller sees why nothing was written. */
export const computeAddComment = (
	doc: string,
	from: number,
	to: number,
	input: NewCommentInput,
): Result<Change[], string> => {
	if (to < from) [from, to] = [to, from];
	if (to === from) return Result.err("Select some text to comment on.");
	({ from, to } = expandInlineCodeSelection(doc, from, to));

	const quote = doc.slice(from, to);
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		quote,
		thread: [{ author: input.author, timestamp: input.createdAt, text: input.text }],
		reactions: [],
	};
	const paraEnd = blockEnd(doc, to);
	return Result.ok([
		{ from, to: from, insert: openMarker(input.id) },
		{ from: to, to, insert: closeMarker(input.id) },
		{ from: paraEnd, to: paraEnd, insert: "\n" + serializeBody(input.id, data) },
	]);
};

/** HTML comments inside a Markdown code span render as literal code. When a
 * selection is within one inline-code token, anchor the whole token so the
 * comment markers remain invisible outside its backtick delimiters. */
export const expandInlineCodeSelection = (doc: string, from: number, to: number): { from: number; to: number } => {
	const lineFrom = doc.lastIndexOf("\n", from - 1) + 1;
	const nextLine = doc.indexOf("\n", to);
	const lineTo = nextLine < 0 ? doc.length : nextLine;

	for (let open = lineFrom; open < lineTo; open++) {
		if (doc.charAt(open) !== "`" || isEscaped(doc, open)) continue;
		const ticks = backtickRun(doc, open, lineTo);
		const contentFrom = open + ticks;
		let cursor = contentFrom;
		while (cursor < lineTo) {
			const candidate = doc.indexOf("`", cursor);
			if (candidate < 0 || candidate >= lineTo) break;
			const closeTicks = backtickRun(doc, candidate, lineTo);
			if (closeTicks === ticks && !isEscaped(doc, candidate)) {
				if (from >= contentFrom && to <= candidate) {
					return { from: open, to: candidate + closeTicks };
				}
				open = candidate + closeTicks - 1;
				break;
			}
			cursor = candidate + closeTicks;
		}
	}

	return { from, to };
};

const backtickRun = (doc: string, from: number, limit: number): number => {
	let to = from;
	while (to < limit && doc.charAt(to) === "`") to++;
	return to - from;
};

const isEscaped = (doc: string, position: number): boolean => {
	let slashes = 0;
	for (let cursor = position - 1; cursor >= 0 && doc.charAt(cursor) === "\\"; cursor--) slashes++;
	return slashes % 2 === 1;
};

export const computeAppendReply = (
	doc: string,
	id: string,
	entry: { createdAt: string; author: string; text: string },
): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: [...c.thread, { author: entry.author, timestamp: entry.createdAt, text: entry.text }],
	}));
};

export const computeSetResolved = (doc: string, id: string, resolved: boolean): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({ ...toData(c), status: resolved ? "resolved" : "open" }));
};

/** Replace the text of the i-th message in a thread. */
export const computeEditEntry = (doc: string, id: string, index: number, text: string): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: c.thread.map((e, i) => (i === index ? { ...e, text } : e)),
	}));
};

/** Remove the i-th message from a thread (used for replies). */
export const computeDeleteEntry = (doc: string, id: string, index: number): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({
		...toData(c),
		thread: c.thread.filter((_, i) => i !== index),
	}));
};

/** Add/remove the author from an emoji reaction. */
export const computeToggleReaction = (
	doc: string,
	id: string,
	emoji: string,
	author: string,
): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => ({ ...toData(c), reactions: toggleReactions(c.reactions, emoji, author) }));
};

const replaceBody = (doc: string, id: string, mutate: (c: ParsedComment) => CommentData): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	if (!c.body) return Result.err("Comment has no body to update.");
	return Result.ok([{ from: c.body.from, to: c.body.to, insert: serializeBody(id, mutate(c)) }]);
};

const toData = (c: ParsedComment): CommentData => {
	return {
		author: c.author,
		createdAt: c.createdAt,
		status: c.status,
		quote: c.quote,
		thread: c.thread,
		reactions: c.reactions,
	};
};

const toggleReactions = (reactions: Reaction[], emoji: string, author: string): Reaction[] => {
	const out = reactions.map((r) => ({ emoji: r.emoji, authors: [...r.authors] }));
	const existing = out.find((r) => r.emoji === emoji);
	if (existing) {
		const idx = existing.authors.indexOf(author);
		if (idx >= 0) existing.authors.splice(idx, 1);
		else existing.authors.push(author);
	} else {
		out.push({ emoji, authors: [author] });
	}
	return out.filter((r) => r.authors.length > 0);
};

export const computeDeleteComment = (doc: string, id: string): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	const ranges: Change[] = [];
	if (c.open) ranges.push({ from: c.open.from, to: c.open.to, insert: "" });
	if (c.close) ranges.push({ from: c.close.from, to: c.close.to, insert: "" });
	if (c.body) {
		let from = c.body.from;
		if (from > 0 && doc.charCodeAt(from - 1) === 10) from -= 1;
		ranges.push({ from, to: c.body.to, insert: "" });
	}
	if (ranges.length === 0) return Result.err("Nothing to delete.");
	ranges.sort((a, b) => a.from - b.from);
	return Result.ok(ranges);
};

/** Apply changes (original coordinates, CM semantics) — used by tests. */
export const applyChanges = (doc: string, changes: Change[]): string => {
	const ordered = changes.map((c, i) => ({ ...c, i })).sort((a, b) => a.from - b.from || a.i - b.i);
	let out = "";
	let last = 0;
	for (const c of ordered) {
		out += doc.slice(last, c.from) + c.insert;
		last = Math.max(last, c.to);
	}
	return out + doc.slice(last);
};

/** End offset of the contiguous (non-blank) block of lines containing `pos`. */
export const blockEnd = (doc: string, pos: number): number => {
	let lineEnd = doc.indexOf("\n", pos);
	if (lineEnd === -1) return doc.length;
	for (;;) {
		const nextStart = lineEnd + 1;
		let nextEnd = doc.indexOf("\n", nextStart);
		if (nextEnd === -1) nextEnd = doc.length;
		if (doc.slice(nextStart, nextEnd).trim() === "") return lineEnd;
		lineEnd = nextEnd;
		if (nextEnd === doc.length) return doc.length;
	}
};
