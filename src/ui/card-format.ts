import { ParsedComment } from "../format/types";
import { isAnchored } from "../format/parse";

/**
 * Content signature of a comment, independent of its document position — drives
 * margin/sidebar card diffing (a card re-renders only when this changes). Every
 * field that affects what the card shows must be included, or edits go unseen.
 */
export const cardSignature = (c: ParsedComment): string => {
	return JSON.stringify([c.status, c.author, c.createdAt, c.thread, c.reactions, isAnchored(c)]);
};

/** A short relative time ("just now", "5m", "3h", "2d") that falls back to an
 *  absolute date past a week. Empty for a missing/invalid timestamp. */
export const formatRelativeTime = (iso?: string): string => {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	const sec = Math.round(diff / 1000);
	if (sec < 45) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
