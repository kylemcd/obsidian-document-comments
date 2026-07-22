/**
 * Body-text escaping for the on-disk comment format.
 *
 * Thread entries are stored one per physical line (`author: text`), so any
 * newline inside an entry — and the backslash used to encode it — must be
 * escaped, or the continuation re-parses as a bogus entry / reaction (a reply
 * `ok\n+1 great` used to split into a comment plus a `+1` reaction). Unescaping
 * only rewrites these exact sequences, so comments written before this scheme
 * (which never contained an escape) still read back byte-for-byte.
 */
export const escapeText = (s: string): string => {
	return s.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
};

export const unescapeText = (s: string): string => {
	return s.replace(/\\(.)/g, (match, c: string) => {
		if (c === "n") return "\n";
		if (c === "r") return "\r";
		if (c === "\\") return "\\";
		return match;
	});
};

/**
 * Reaction authors are comma-joined on one line, so a name containing a comma
 * ("Doe, Jane") would split into two authors and break the "is-mine" toggle.
 * Escape commas (and the escaping backslash) per author on the way out, and
 * split only on unescaped commas on the way back in.
 */
export const escapeReactionAuthor = (s: string): string => {
	return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
};

export const splitReactionAuthors = (s: string): string[] => {
	return s
		.split(/(?<!\\),/)
		.map((author) =>
			author.trim().replace(/\\(.)/g, (match, c: string) => (c === "," ? "," : c === "\\" ? "\\" : match)),
		)
		.filter(Boolean);
};
