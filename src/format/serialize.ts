import { CommentData, ThreadEntry } from "./types";
import { escapeReactionAuthor, escapeText } from "./escape";

export const openMarker = (id: string): string => {
	return `<!--c:${id}-->`;
};

export const closeMarker = (id: string): string => {
	return `<!--/c:${id}-->`;
};

/** Serialize a comment body block: `<!--co:ID header\n thread\n-->`. */
export const serializeBody = (id: string, data: CommentData): string => {
	const head: string[] = [`co:${id}`];
	if (data.author) head.push(`by:${sanitizeToken(data.author)}`);
	if (data.createdAt) head.push(`at:${sanitizeToken(data.createdAt)}`);
	head.push(`status:${data.status}`);
	if (data.quote) head.push(`quote:"${sanitizeQuote(data.quote)}"`);

	const lines = data.thread.map(serializeEntry);
	const reactionLines = (data.reactions ?? [])
		.filter((r) => r.authors.length > 0)
		.map((r) => `+${r.emoji} ${r.authors.map(escapeReactionAuthor).join(", ")}`);
	const body = [...lines, ...reactionLines];
	const block = body.length ? body.join("\n") + "\n" : "";
	return `<!--${head.join(" ")}\n${block}-->`;
};

const serializeEntry = (e: ThreadEntry): string => {
	const who = e.timestamp ? `${e.author} (${e.timestamp})` : e.author;
	// Break `-->` in the author too — it sits on the entry line inside the block.
	return `${breakTerminator(who)}: ${escapeText(sanitizeBodyText(e.text))}`;
};

/** Body text must never contain the comment terminator `-->`. Break it with a
 *  zero-width space so the block stays well-formed and the text reads the same. */
export const sanitizeBodyText = (s: string): string => {
	return breakTerminator(s);
};

/** Header values sit on the block's first line, which the terminator can't cross.
 *  Break any `-->` (whitespace/quote normalization alone left the header able to
 *  end the HTML comment early, leaking the thread into every non-plugin renderer). */
const sanitizeToken = (s: string): string => {
	return breakTerminator(s).replace(/\s+/g, "_");
};

const sanitizeQuote = (s: string): string => {
	return breakTerminator(s.replace(/\s+/g, " ").replace(/"/g, "'")).trim();
};

const breakTerminator = (s: string): string => {
	return s.replace(/-->/g, "--​>");
};
