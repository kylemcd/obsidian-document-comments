import type { ParsedComment } from "./types";

export const commentPreview = (comment: ParsedComment): string | null => {
	const first = comment.thread[0];
	if (!first) return null;
	const text = first.text.trim().replace(/\s+/g, " ");
	if (!text) return null;
	const author = first.author || comment.author || "Comment";
	return `${author}: ${text}`;
};
