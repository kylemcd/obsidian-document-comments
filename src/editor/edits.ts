import { Result } from "better-result";
import { CommentData, ParsedComment, Reaction, ReactionTarget, TextRange } from "../format/types";
import {
	anchorRange,
	fencedRanges,
	hasClosingFence,
	isAnchored,
	isHighlight,
	isInFencedCode,
	parseComments,
} from "../format/parse";
import { codeSelectionTarget, isCodeComment, resolveCodeAnchor } from "../format/code-anchor";
import { closeMarker, openMarker, serializeBody } from "../format/serialize";
import { clampToTableCells } from "../format/table";
import { MARKER_GUARD, anchorOffBlockMarkup, needsMarkerGuard } from "../format/line-start";

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
	/** Empty comment selected when the composer opened. Resolve this id against
	 *  fresh content instead of rediscovering it from a stale selection. */
	targetHighlightId?: string;
	/** Whether a new empty comment can persist as a highlight. Existing highlights
	 *  can still be removed when this is false. Defaults to true for format callers. */
	allowEmpty?: boolean;
	/** The text the user selected, captured when the composer opened. When the
	 *  document shifted underneath (sync, another pane) before the write lands,
	 *  the offsets no longer point at it and creation is refused rather than
	 *  anchoring the wrong text. */
	expected?: string;
};

export type ToggleReactionInput = ReactionTarget & {
	doc: string;
	author: string;
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
	if (input.targetHighlightId) {
		const target = parseComments(doc).find((comment) => comment.id === input.targetHighlightId);
		if (!target?.body || !isAnchored(target)) {
			return Result.err("The empty comment no longer exists.");
		}
		if (input.text) {
			return computeAppendReply(doc, target.id, {
				createdAt: input.createdAt,
				author: input.author,
				text: input.text,
			});
		}
		if (target.thread.length > 0) {
			return Result.err("The empty comment now has text. Open the comment to make changes.");
		}
		return computeDeleteComment(doc, target.id);
	}
	if (to === from) return Result.err("Select some text to comment on.");
	if (input.expected !== undefined && doc.slice(from, to) !== input.expected) {
		return Result.err("The selection moved — try adding the comment again.");
	}
	const highlight = findHighlightAtSelection(doc, from, to);
	if (highlight) {
		return input.text
			? computeAppendReply(doc, highlight.id, {
					createdAt: input.createdAt,
					author: input.author,
					text: input.text,
				})
			: computeDeleteComment(doc, highlight.id);
	}
	if (!input.text && input.allowEmpty === false) return Result.ok([]);
	// Markers can't live inside a fence (they'd render literally and the parser
	// masks them), so a code selection anchors the whole block with a line target.
	if (isInFencedCode(doc, from) || isInFencedCode(doc, to - 1)) {
		return computeAddCodeComment(doc, from, to, input);
	}
	const cell = clampToTableCells(doc, from, to);
	if (cell.to === cell.from) return Result.err("Select the text inside a table cell, not its borders.");
	({ from, to } = anchorText(doc, cell));
	if (to === from) return Result.err("Select some text to comment on.");

	const quote = doc.slice(from, to);
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		quote,
		thread: input.text ? [{ author: input.author, timestamp: input.createdAt, text: input.text }] : [],
		reactions: [],
	};
	const paraEnd = blockEnd(doc, to);
	return Result.ok([
		{ from, to: from, insert: guardFor(doc, from) + openMarker(input.id) },
		{ from: to, to, insert: guardFor(doc, to) + closeMarker(input.id) },
		{ from: paraEnd, to: paraEnd, insert: "\n" + serializeBody(input.id, data) },
	]);
};

const guardFor = (doc: string, pos: number): string => (needsMarkerGuard(doc, pos) ? MARKER_GUARD : "");

/** Find an empty-thread highlight whose complete target matches the selection. */
export const findHighlightAtSelection = (doc: string, from: number, to: number): ParsedComment | null => {
	if (to < from) [from, to] = [to, from];
	if (to === from) return null;
	const comments = parseComments(doc).filter(isHighlight);

	if (isInFencedCode(doc, from) || isInFencedCode(doc, to - 1)) {
		const target = codeSelectionTarget(doc, from, to);
		if (!target) return null;
		return (
			comments.find((comment) => {
				if (!isCodeComment(comment)) return false;
				const range = resolveCodeAnchor(doc, comment);
				return !!range && range.from === target.range.from && range.to === target.range.to;
			}) ?? null
		);
	}

	const at = (start: number, end: number): ParsedComment | undefined =>
		comments.find((comment) => {
			if (isCodeComment(comment)) return false;
			const range = anchorRange(comment);
			return !!range && range.from === start && range.to === end;
		});
	// A selection of exactly a highlight's text is that highlight, wherever moving
	// its ends off markup or out of code would take them now that it's written.
	const exact = at(from, to);
	if (exact) return exact;
	const anchor = anchorSelection(doc, from, to);
	const found = at(anchor.from, anchor.to);
	if (found) return found;
	// Writing a comment can move its markers off the ends of the selection that
	// made it, past markup or a guard or back to the text it ended on, and put its
	// thread inside it. Mapped onto the new text, that selection takes them in. It
	// is still the same selection if it anchors the comment again once the
	// comment's own markers and thread come back out.
	const outside = (range: TextRange): number => Math.max(0, range.from - from) + Math.max(0, to - range.to);
	return (
		comments
			.flatMap((comment) => {
				const range = isCodeComment(comment) ? null : anchorRange(comment);
				return range && range.from <= to && range.to >= from ? [{ comment, range }] : [];
			})
			// Anchoring only trims an end or widens it to whole code lines, so the
			// comment a selection made covers nearly all of it. Each check reads the
			// whole note, so only the few that cover the most get one.
			.sort((a, b) => outside(a.range) - outside(b.range))
			.slice(0, 3)
			.find(({ comment, range }) => reanchors(doc, comment.id, range, from, to))?.comment ?? null
	);
};

/** Whether the selection [from, to] anchors comment `id`, which wraps `range`, in
 *  the text it was written into: `doc` with that comment taken back out. */
const reanchors = (doc: string, id: string, range: TextRange, from: number, to: number): boolean => {
	const removal = computeDeleteComment(doc, id);
	if (removal.isErr()) return false;
	const cuts = removal.value;
	// Where a position lands once the cuts are made: back by every cut before it,
	// and to the start of one it's inside.
	const map = (pos: number): number =>
		pos - cuts.reduce((gone, cut) => gone + Math.max(0, Math.min(pos, cut.to) - cut.from), 0);
	const anchor = anchorSelection(applyChanges(doc, cuts), map(from), map(to));
	return anchor.from === map(range.from) && anchor.to === map(range.to);
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
	// With no closing fence the block runs to the end of the note, so the closing
	// marker and the comment would both land in the code and show as text.
	if (!hasClosingFence(doc, target.fenceStart)) return Result.err("Close the code block before commenting on it.");
	const data: CommentData = {
		author: input.author,
		createdAt: input.createdAt,
		status: "open",
		quote: target.quote,
		codeLines: target.codeLines,
		thread: input.text ? [{ author: input.author, timestamp: input.createdAt, text: input.text }] : [],
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

/** Normalize a raw selection to the range we actually wrap in markers. Both the
 *  write and the "is this already a highlight?" lookup have to agree, or running
 *  Add comment twice on the same text stops finding the comment it just made. */
const anchorSelection = (doc: string, from: number, to: number): TextRange => {
	return anchorText(doc, clampToTableCells(doc, from, to));
};

/** Everything anchorSelection does after the table clamp, split out so creation
 *  can tell a selection of table borders from one of block markup. */
const anchorText = (doc: string, cell: TextRange): TextRange => {
	const text = anchorOffBlockMarkup(doc, cell.from, cell.to);
	return expandInlineCodeSelection(doc, text.from, text.to);
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
		return {
			...toData(c),
			thread: c.thread.filter((_, i) => i !== index),
			reactions: reactionsAfterEntryDelete(c.reactions, index),
		};
	});
};

/** Add/remove the author from an emoji reaction. */
export const computeToggleReaction = ({
	doc,
	id,
	entry,
	emoji,
	author,
}: ToggleReactionInput): Result<Change[], string> => {
	return replaceBody(doc, id, (c) => {
		const entryCount = Math.max(1, c.thread.length);
		if (!Number.isSafeInteger(entry) || entry < 0 || entry >= entryCount) return null;
		return { ...toData(c), reactions: toggleReactions(c.reactions, entry, emoji, author) };
	});
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

const toggleReactions = (reactions: Reaction[], entry: number, emoji: string, author: string): Reaction[] => {
	const out = reactions.map((reaction) => ({ ...reaction, authors: [...reaction.authors] }));
	const existing = out.find((reaction) => (reaction.entry ?? 0) === entry && reaction.emoji === emoji);
	if (existing) {
		const idx = existing.authors.indexOf(author);
		if (idx >= 0) existing.authors.splice(idx, 1);
		else existing.authors.push(author);
	} else {
		out.push(entry === 0 ? { emoji, authors: [author] } : { emoji, authors: [author], entry });
	}
	return out.filter((r) => r.authors.length > 0);
};

const reactionsAfterEntryDelete = (reactions: Reaction[], deletedEntry: number): Reaction[] => {
	return reactions.flatMap((reaction) => {
		const entry = reaction.entry ?? 0;
		if (entry === deletedEntry) return [];
		const nextEntry = entry > deletedEntry ? entry - 1 : entry;
		const copied = { emoji: reaction.emoji, authors: [...reaction.authors] };
		return [nextEntry === 0 ? copied : { ...copied, entry: nextEntry }];
	});
};

export const computeDeleteComment = (doc: string, id: string): Result<Change[], string> => {
	const comment = parseComments(doc).find((x) => x.id === id);
	if (!comment) return Result.err("Comment not found.");
	// Remove EVERY occurrence of this id's markers/body, not just the first the
	// parser records. Copy-pasting a commented span duplicates the markers; deleting
	// only the first pair used to leave invisible, UI-unremovable leftovers behind.
	const ranges: Change[] = [];
	// Length of the line terminator ending at / starting at a boundary, counting CRLF
	// as one unit. `charCodeAt` past either end of the string is NaN, so both read 0
	// there — no bounds guards needed. Handling CRLF matters because deletes on the
	// raw-file path (sidebar / Reading view) see the file's real endings: an LF-only
	// check left a marker's `\r\n` behind as a stray blank line around the code block.
	const leadingTerm = (p: number): number =>
		doc.charCodeAt(p - 1) === 10 ? (doc.charCodeAt(p - 2) === 13 ? 2 : 1) : 0;
	const trailingTerm = (p: number): number =>
		doc.charCodeAt(p) === 13 && doc.charCodeAt(p + 1) === 10 ? 2 : doc.charCodeAt(p) === 10 ? 1 : 0;
	// A code comment's markers sit on lines of their own that it added around the
	// block, so they take their line terminator with them, and deleting the comment
	// leaves no blank line there. Any other comment's marker alone on its line was
	// written onto a line that was blank already, which stays.
	const ownLines = isCodeComment(comment);
	const aloneOnLine = (from: number, to: number): boolean =>
		ownLines && (from === 0 || leadingTerm(from) > 0) && (to === doc.length || trailingTerm(to) > 0);
	scanAll(doc, new RegExp(`<!--c:${id}-->`, "g"), (from, to) => {
		const end = aloneOnLine(from, to) ? to + trailingTerm(to) : to;
		ranges.push({ from, to: end, insert: "" });
	});
	scanAll(doc, new RegExp(`<!--/c:${id}-->`, "g"), (from, to) => {
		const start = aloneOnLine(from, to) ? from - leadingTerm(from) : from;
		ranges.push({ from: start, to, insert: "" });
	});
	const markers = ranges.length;
	scanAll(doc, new RegExp(`<!--co:${id}(?![A-Za-z0-9])[\\s\\S]*?-->`, "g"), (from, to) => {
		// Swallow the whole line terminator before the body so its line disappears
		// cleanly, CR included, leaving no stray blank line.
		ranges.push({ from: from - leadingTerm(from), to, insert: "" });
	});
	if (ranges.length === 0) return Result.err("Nothing to delete.");
	// A guard belongs to the marker right after it, so it goes with that marker
	// unless another comment's marker is left behind it to guard.
	const pastRemoved = (pos: number): number => {
		const next = ranges.find((range) => range.from === pos && range.to > pos);
		return next ? pastRemoved(next.to) : pos;
	};
	const guarded = ranges.map((range, index) => {
		if (index >= markers || doc.charAt(range.from - 1) !== MARKER_GUARD) return range;
		const next = pastRemoved(range.to);
		return doc.startsWith("<!--c:", next) || doc.startsWith("<!--/c:", next)
			? range
			: { ...range, from: range.from - 1 };
	});
	guarded.sort((a, b) => a.from - b.from);
	return Result.ok(guarded);
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

/** End offset of the contiguous (non-blank) block of lines containing `pos`. A
 *  fenced block counts as one piece, blank lines and all: a comment written at a
 *  blank line inside one shows as code. One with no closing fence runs to the end
 *  of the note, so the block ends before it instead. */
export const blockEnd = (doc: string, pos: number): number => {
	const fences = fencedRanges(doc);
	let lineEnd = doc.indexOf("\n", pos);
	if (lineEnd === -1) return doc.length;
	for (;;) {
		const nextStart = lineEnd + 1;
		const fence = fences.find(([fenceStart]) => fenceStart === nextStart);
		if (fence) {
			if (!hasClosingFence(doc, fence[0])) return lineEnd;
			lineEnd = fence[1];
			if (lineEnd >= doc.length) return doc.length;
			continue;
		}
		let nextEnd = doc.indexOf("\n", nextStart);
		if (nextEnd === -1) nextEnd = doc.length;
		if (doc.slice(nextStart, nextEnd).trim() === "") return lineEnd;
		lineEnd = nextEnd;
		if (nextEnd === doc.length) return doc.length;
	}
};
