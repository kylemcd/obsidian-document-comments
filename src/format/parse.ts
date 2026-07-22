import { CommentData, CommentStatus, ParsedComment, Reaction, TextRange, ThreadEntry } from "./types";
import { decodeCodeQuote, splitReactionAuthors, unescapeText } from "./escape";

// Anchor + body markers. All are HTML comments so they're invisible everywhere.
const OPEN_RE = /<!--c:([A-Za-z0-9]+)-->/g;
const CLOSE_RE = /<!--\/c:([A-Za-z0-9]+)-->/g;
// <!--co:ID <header, rest of first line>\n <thread...> -->
const BODY_RE = /<!--co:([A-Za-z0-9]+)[ \t]*([^\n]*)\n?([\s\S]*?)-->/g;

const HEADER_ATTR_RE = /(\w+):(?:"([^"]*)"|(\S+))/g;
// author, optional "(timestamp)", then ": text"
const THREAD_LINE_RE = /^(.*?)(?:\s\(([^)]*)\))?:\s?([\s\S]*)$/;

/** Parse every comment in a document, in order of first appearance. */
export const parseComments = (doc: string): ParsedComment[] => {
	const masks = maskedRanges(doc);
	const masked = (index: number) => isInside(masks, index);

	const opens = new Map<string, TextRange>();
	const closes = new Map<string, TextRange>();
	const bodies = new Map<string, { range: TextRange; data: CommentData }>();
	const order: string[] = [];
	const seen = new Set<string>();
	const track = (id: string) => {
		if (!seen.has(id)) {
			seen.add(id);
			order.push(id);
		}
	};

	// Three global-regex scans, each first-wins into a map while recording first-seen
	// order — stateful accumulation that doesn't reduce to a single array method.
	let m: RegExpExecArray | null;

	OPEN_RE.lastIndex = 0;
	while ((m = OPEN_RE.exec(doc))) {
		const [full, id] = m;
		if (id === undefined || full === undefined || masked(m.index)) continue;
		if (!opens.has(id)) opens.set(id, { from: m.index, to: m.index + full.length });
		track(id);
	}

	CLOSE_RE.lastIndex = 0;
	while ((m = CLOSE_RE.exec(doc))) {
		const [full, id] = m;
		if (id === undefined || full === undefined || masked(m.index)) continue;
		if (!closes.has(id)) closes.set(id, { from: m.index, to: m.index + full.length });
		track(id);
	}

	BODY_RE.lastIndex = 0;
	while ((m = BODY_RE.exec(doc))) {
		const [full, id] = m;
		if (id === undefined || full === undefined || masked(m.index)) continue;
		if (!bodies.has(id)) {
			const { thread, reactions } = parseBody(m[3] ?? "");
			const data: CommentData = {
				...parseHeader(m[2] ?? ""),
				thread,
				reactions,
			};
			bodies.set(id, { range: { from: m.index, to: m.index + full.length }, data });
		}
		track(id);
	}

	return order.map((id) => {
		const body = bodies.get(id);
		const data: CommentData = body ? body.data : { status: "open", thread: [], reactions: [] };
		return {
			id,
			author: data.author,
			createdAt: data.createdAt,
			status: data.status,
			quote: data.quote,
			codeLines: data.codeLines,
			thread: data.thread,
			reactions: data.reactions,
			open: opens.get(id) ?? null,
			close: closes.get(id) ?? null,
			body: body ? body.range : null,
		};
	});
};

/** The set of ids already present in a document (for id generation). */
export const existingIds = (doc: string): Set<string> => new Set(parseComments(doc).map((c) => c.id));

/** A comment is anchored when both markers are present and ordered. */
export const isAnchored = (c: ParsedComment): boolean => {
	return !!c.open && !!c.close && c.open.to <= c.close.from;
};

/** A floating margin card needs both its thread body and a valid text anchor.
 * Orphaned threads remain available in the sidebar, where no anchor is needed. */
export const hasMarginAnchor = (c: ParsedComment): boolean => {
	return !!c.body && isAnchored(c);
};

/** The highlighted text range (between the markers), or null if not anchored. */
export const anchorRange = (c: ParsedComment): TextRange | null => {
	if (!c.open || !c.close || c.open.to > c.close.from) return null;
	return { from: c.open.to, to: c.close.from };
};

/** Has content (a body) but is not properly anchored — show in the unanchored list. */
export const isOrphan = (c: ParsedComment): boolean => {
	return !!c.body && !isAnchored(c);
};

const parseHeader = (header: string): Omit<CommentData, "thread" | "reactions"> => {
	const attrs: Record<string, string> = {};
	let m: RegExpExecArray | null;
	HEADER_ATTR_RE.lastIndex = 0;
	while ((m = HEADER_ATTR_RE.exec(header))) {
		const key = m[1];
		const value = m[2] ?? m[3];
		if (key !== undefined && value !== undefined) attrs[key] = value;
	}
	const status: CommentStatus = attrs.status === "resolved" ? "resolved" : "open";
	const codeLines = parseLineRange(attrs.line);
	// A code comment's quote is stored encoded (exact); a prose quote is stored
	// already-collapsed, so it's used verbatim.
	const quote = attrs.quote === undefined ? undefined : codeLines ? decodeCodeQuote(attrs.quote) : attrs.quote;
	return {
		author: attrs.by,
		createdAt: attrs.at,
		status,
		quote,
		codeLines,
	};
};

/** Parse a `line:F-T` (or `line:F`) header value into an inclusive line range. */
const parseLineRange = (value: string | undefined): TextRange | undefined => {
	if (!value) return undefined;
	const match = /^(\d+)(?:-(\d+))?$/.exec(value);
	if (!match || match[1] === undefined) return undefined;
	const from = Number(match[1]);
	const to = match[2] !== undefined ? Number(match[2]) : from;
	return to >= from ? { from, to } : undefined;
};

/** Fenced code-block ranges (``` or ~~~), from the opening fence to the closing
 *  fence line. Single-pass line scanner with fence-open/close state — doesn't map
 *  to an array method. */
export const fencedRanges = (doc: string): Array<[number, number]> => {
	const ranges: Array<[number, number]> = [];
	let offset = 0;
	let fenceStart = -1;
	let fenceChar = "";
	for (const line of doc.split("\n")) {
		const lineEnd = offset + line.length;
		const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fenceStart < 0 && marker) {
			fenceStart = offset;
			fenceChar = marker[0] ?? "";
		} else if (fenceStart >= 0 && marker && marker[0] === fenceChar) {
			ranges.push([fenceStart, lineEnd]);
			fenceStart = -1;
		}
		offset = lineEnd + 1;
	}
	if (fenceStart >= 0) ranges.push([fenceStart, doc.length]);
	return ranges;
};

/** True when `pos` sits inside a fenced code block — anchoring a comment there
 *  would write literal marker text into the code, so creation refuses it. */
export const isInFencedCode = (doc: string, pos: number): boolean => {
	return isInside(fencedRanges(doc), pos);
};

/** Ranges that should be ignored when scanning for markers: fenced and inline code. */
const maskedRanges = (doc: string): Array<[number, number]> => {
	const ranges = fencedRanges(doc);

	// Inline code spans.
	const inline = /`+[^`\n]*`+/g;
	let m: RegExpExecArray | null;
	while ((m = inline.exec(doc))) ranges.push([m.index, m.index + m[0].length]);

	return ranges;
};

const isInside = (ranges: Array<[number, number]>, index: number): boolean => {
	return ranges.some(([from, to]) => index >= from && index < to);
};

const REACTION_LINE_RE = /^\+\s*(\S+)\s+(.+)$/;

const parseBody = (block: string): { thread: ThreadEntry[]; reactions: Reaction[] } => {
	const thread: ThreadEntry[] = [];
	const reactions: Reaction[] = [];
	for (const raw of block.split("\n")) {
		// Strip only a trailing CR (CRLF files) — trailing spaces inside an entry
		// are meaningful and survive because newlines are escaped, not folded.
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "") continue;

		const rx = REACTION_LINE_RE.exec(line);
		if (rx && rx[1] !== undefined && rx[2] !== undefined) {
			reactions.push({ emoji: rx[1], authors: splitReactionAuthors(rx[2]) });
			continue;
		}

		const m = THREAD_LINE_RE.exec(line);
		const last = thread[thread.length - 1];
		if (m && m[1] !== undefined && m[3] !== undefined && m[1].trim() !== "") {
			thread.push({ author: m[1].trim(), timestamp: m[2] || undefined, text: unescapeText(m[3]) });
		} else if (last) {
			// Unstructured continuation line (legacy, pre-escaping) — fold into the previous entry.
			last.text += "\n" + unescapeText(line);
		} else {
			thread.push({ author: "", text: unescapeText(line) });
		}
	}
	return { thread, reactions };
};
