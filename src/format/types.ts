export type CommentStatus = "open" | "resolved";

export type ThreadEntry = {
	author: string;
	/** ISO-8601 timestamp, optional (the first entry usually carries it via the header). */
	timestamp?: string;
	text: string;
};

export type Reaction = {
	emoji: string;
	authors: string[];
};

/** The content of a comment, independent of where it sits in the document. */
export type CommentData = {
	author?: string;
	createdAt?: string;
	status: CommentStatus;
	/** Redundant copy of the anchored text — the re-anchor fallback. */
	quote?: string;
	/** Present only for a comment anchored to lines inside a fenced code block.
	 *  The markers wrap the whole block; these are the block-relative line indices
	 *  (0-based, inclusive) the comment actually targets. `quote` is the re-anchor
	 *  key; these lines are the fast path and the disambiguator. */
	codeLines?: TextRange;
	thread: ThreadEntry[];
	reactions: Reaction[];
};

export type TextRange = {
	from: number;
	to: number;
};

/** A comment as found in a document, with resolved offsets for each piece. */
export type ParsedComment = {
	id: string;
	/** `<!--c:ID-->` marker range, or null if missing. */
	open: TextRange | null;
	/** `<!--/c:ID-->` marker range, or null if missing. */
	close: TextRange | null;
	/** `<!--co:ID ...-->` body block range, or null if missing. */
	body: TextRange | null;
} & CommentData;
