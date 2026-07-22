import { Result } from "better-result";
import { CommentData, ParsedComment, Reaction } from "../format/types";
import { isInFencedCode, parseComments } from "../format/parse";
import { codeSelectionTarget } from "../format/code-anchor";
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
	/** The text the user selected, captured when the composer opened. When the
	 *  document shifted underneath (sync, another pane) before the write lands,
	 *  the offsets no longer point at it and creation is refused rather than
	 *  anchoring the wrong text. */
	expected?: string;
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
	if (input.expected !== undefined && doc.slice(from, to) !== input.expected) {
		return Result.err("The selection moved — try adding the comment again.");
	}
	// Markers can't live inside a fence (they'd render literally and the parser
	// masks them), so a code selection anchors the whole block with a line target.
	if (isInFencedCode(doc, from) || isInFencedCode(doc, to - 1)) {
		return computeAddCodeComment(doc, from, to, input);
	}
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

/** Anchor a code selection: wrap the whole fenced block with own-line markers and
 *  record the block-relative line range + exact code as the body's `line:`/`quote:`. */
const computeAddCodeComment = (
	doc: string,
	from: number,
	to: number,
	input: NewCommentInput,
): Result<Change[], string> => {
	const target = codeSelectionTarget(doc, from, to);
	if (!target) return Result.err("Couldn't map that selection to code lines.");
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		quote: target.quote,
		codeLines: target.codeLines,
		thread: [{ author: input.author, timestamp: input.createdAt, text: input.text }],
		reactions: [],
	};
	return Result.ok([
		{ from: target.fenceStart, to: target.fenceStart, insert: openMarker(input.id) + "\n" },
		{
			from: target.fenceEnd,
			to: target.fenceEnd,
			insert: "\n" + closeMarker(input.id) + "\n" + serializeBody(input.id, data),
		},
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
	return replaceBody(doc, id, (c) => {
		if (index < 0 || index >= c.thread.length) return null;
		return { ...toData(c), thread: c.thread.map((e, i) => (i === index ? { ...e, text } : e)) };
	});
};

/** Remove the i-th message from a thread (used for replies). */
export const computeDeleteEntry = (doc: string, id: string, index: number): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => {
		if (index < 0 || index >= c.thread.length) return null;
		return { ...toData(c), thread: c.thread.filter((_, i) => i !== index) };
	});
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

const replaceBody = (
	doc: string,
	id: string,
	mutate: (c: ParsedComment) => CommentData | null,
): Result<Change[], string> => {
	const c = parseComments(doc).find((x) => x.id === id);
	if (!c) return Result.err("Comment not found.");
	if (!c.body) return Result.err("Comment has no body to update.");
	const data = mutate(c);
	if (!data) return Result.err("That reply no longer exists.");
	return Result.ok([{ from: c.body.from, to: c.body.to, insert: serializeBody(id, data) }]);
};

const toData = (c: ParsedComment): CommentData => {
	return {
		author: c.author,
		createdAt: c.createdAt,
		status: c.status,
		quote: c.quote,
		codeLines: c.codeLines,
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
	if (!parseComments(doc).some((x) => x.id === id)) return Result.err("Comment not found.");
	// Remove EVERY occurrence of this id's markers/body, not just the first the
	// parser records. Copy-pasting a commented span duplicates the markers; deleting
	// only the first pair used to leave invisible, UI-unremovable leftovers behind.
	const ranges: Change[] = [];
	// A marker alone on its line (code-comment block wrap) takes its newline with it,
	// so deleting the comment doesn't leave a blank line around the code block.
	const aloneOnLine = (from: number, to: number): boolean =>
		(from === 0 || doc.charCodeAt(from - 1) === 10) && (to === doc.length || doc.charCodeAt(to) === 10);
	scanAll(doc, new RegExp(`<!--c:${id}-->`, "g"), (from, to) => {
		const end = aloneOnLine(from, to) && to < doc.length ? to + 1 : to;
		ranges.push({ from, to: end, insert: "" });
	});
	scanAll(doc, new RegExp(`<!--/c:${id}-->`, "g"), (from, to) => {
		const start = aloneOnLine(from, to) && from > 0 ? from - 1 : from;
		ranges.push({ from: start, to, insert: "" });
	});
	scanAll(doc, new RegExp(`<!--co:${id}(?![A-Za-z0-9])[\\s\\S]*?-->`, "g"), (from, to) => {
		// Swallow the newline before the body so its line disappears cleanly,
		// including the CR of a CRLF pair so no stray \r is left behind.
		let start = from;
		if (start > 0 && doc.charCodeAt(start - 1) === 10) start -= 1;
		if (start > 0 && doc.charCodeAt(start - 1) === 13) start -= 1;
		ranges.push({ from: start, to, insert: "" });
	});
	if (ranges.length === 0) return Result.err("Nothing to delete.");
	ranges.sort((a, b) => a.from - b.from);
	return Result.ok(ranges);
};

/** Invoke `fn(from, to)` for every match of a global regex. Stateful cursor scan. */
const scanAll = (doc: string, re: RegExp, fn: (from: number, to: number) => void): void => {
	let m: RegExpExecArray | null;
	while ((m = re.exec(doc))) fn(m.index, m.index + m[0].length);
};

/** Apply changes (original coordinates, CM semantics) — used by tests. */
export const applyChanges = (doc: string, changes: Change[]): string => {
	const ordered = changes.map((c, i) => ({ ...c, i })).sort((a, b) => a.from - b.from || a.i - b.i);
	// Single pass building the output string while advancing a consumed-up-to
	// watermark — two coupled outputs, so a plain map/reduce wouldn't read cleaner.
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
