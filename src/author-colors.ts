import { Result } from "better-result";
import type { ParsedComment } from "./format/types";

export type HexColor = `#${string}`;
export type ResolvedAuthorColor = HexColor | null;
export type AuthorColorResolver = (author: string) => ResolvedAuthorColor;
export type AuthorColorMode = "generated" | "custom";

export type AuthorColorAssignment = {
	color: HexColor;
	mode: AuthorColorMode;
};

export type AuthorColorAssignments = Record<string, AuthorColorAssignment>;

// Matches the yellow highlight used before per-author colors were introduced.
export const DEFAULT_HIGHLIGHT_COLOR = "#f2b90d" as const satisfies HexColor;

export type AuthorColorResolution = {
	author: string;
	color: ResolvedAuthorColor;
	created: boolean;
};

// Radix Colors 3 light scale, step 9. Step 9 is Radix's highest-chroma accent
// step and is intended for overlays and accent borders.
export const AUTHOR_COLOR_PALETTE = [
	"#0090ff", // blue
	"#e54d2e", // tomato
	"#46a758", // grass
	"#6e56cf", // violet
	"#ffc53d", // amber
	"#00a2c7", // cyan
	"#d6409f", // pink
	"#12a594", // teal
	"#f76b15", // orange
	"#3e63dd", // indigo
	"#bdee63", // lime
	"#8e4ec6", // purple
] as const satisfies readonly HexColor[];

type AssignmentEntry = readonly [string, AuthorColorAssignment];

export const canonicalAuthorKey = (author: string): string => {
	return author.trim().replace(/-->/g, "--​>").replace(/\s+/g, "_");
};

export const creatorForComment = (comment: ParsedComment): string | null => {
	const author = canonicalAuthorKey(comment.author ?? comment.thread[0]?.author ?? "");
	return author || null;
};

export const creatorsForComments = (comments: readonly ParsedComment[]): string[] => {
	return [...new Set(comments.map(creatorForComment).filter((author) => author !== null))].sort((a, b) =>
		a.localeCompare(b),
	);
};

export const commentersForComments = (comments: readonly ParsedComment[]): string[] => {
	const authors = comments.flatMap((comment) => [
		creatorForComment(comment),
		...comment.thread.map((entry) => canonicalAuthorKey(entry.author) || null),
	]);
	return [...new Set(authors.filter((author) => author !== null))].sort((a, b) => a.localeCompare(b));
};

export const parseHexColor = (value: unknown): Result<HexColor, string> => {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
		return Result.err("Expected a six-digit hexadecimal color.");
	}
	return Result.ok(value.toLowerCase() as HexColor);
};

const parseAssignment = (key: string, value: unknown): Result<AssignmentEntry, string> => {
	if (!value || typeof value !== "object") return Result.err(`Invalid color assignment for ${key}.`);
	const candidate = value as Partial<AuthorColorAssignment>;
	if (candidate.mode !== "generated" && candidate.mode !== "custom") {
		return Result.err(`Invalid color mode for ${key}.`);
	}
	const mode = candidate.mode;
	return parseHexColor(candidate.color).map((color) => [canonicalAuthorKey(key), { color, mode }] as const);
};

export const hydrateAuthorColors = (value: unknown): AuthorColorAssignments => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const results = Object.entries(value).map(([key, assignment]) => parseAssignment(key, assignment));
	const [valid] = Result.partition(results);
	return Object.fromEntries(valid.filter(([key]) => key));
};

export const hydrateExcludedAuthors = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	const authors = value
		.filter((author): author is string => typeof author === "string")
		.map(canonicalAuthorKey)
		.filter(Boolean);
	return [...new Set(authors)].sort((a, b) => a.localeCompare(b));
};

const stableHash = (value: string): number => {
	return [...value].reduce((hash, character) => (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0, 0);
};

export const generatedColorForAuthor = (author: string, assignments: Readonly<AuthorColorAssignments>): HexColor => {
	const usage = AUTHOR_COLOR_PALETTE.map((color) => ({
		color,
		count: Object.values(assignments).filter((assignment) => assignment.color === color).length,
	}));
	const unused = usage.find(({ count }) => count === 0);
	if (unused) return unused.color;

	const minimum = Math.min(...usage.map(({ count }) => count));
	const leastUsed = usage.filter(({ count }) => count === minimum);
	return leastUsed[stableHash(canonicalAuthorKey(author)) % leastUsed.length]?.color ?? AUTHOR_COLOR_PALETTE[0];
};

export const ensureAuthorColor = (
	assignments: AuthorColorAssignments,
	author: string,
): { assignment: AuthorColorAssignment; created: boolean; author: string } => {
	const key = canonicalAuthorKey(author);
	const existing = assignments[key];
	if (existing) return { assignment: existing, created: false, author: key };

	const assignment: AuthorColorAssignment = {
		color: generatedColorForAuthor(key, assignments),
		mode: "generated",
	};
	assignments[key] = assignment;
	return { assignment, created: true, author: key };
};

export const ensureAuthorColors = (
	assignments: AuthorColorAssignments,
	authors: readonly string[],
	excludedAuthors: ReadonlySet<string>,
): boolean => {
	const canonicalAuthors = [...new Set(authors.map(canonicalAuthorKey).filter(Boolean))]
		.filter((author) => !excludedAuthors.has(author))
		.sort((a, b) => a.localeCompare(b));
	return canonicalAuthors.map((author) => ensureAuthorColor(assignments, author)).some(({ created }) => created);
};

export const resolveAuthorColor = (
	assignments: AuthorColorAssignments,
	excludedAuthors: ReadonlySet<string>,
	author: string,
	enabled: boolean,
): AuthorColorResolution => {
	const key = canonicalAuthorKey(author);
	if (!key || excludedAuthors.has(key)) return { author: key, color: null, created: false };
	const ensured = ensureAuthorColor(assignments, key);
	return {
		author: key,
		color: enabled ? ensured.assignment.color : null,
		created: ensured.created,
	};
};

export const authorColorCss = (color: ResolvedAuthorColor): string => color ?? "var(--text-normal)";

export const effectiveHighlightColor = (
	color: ResolvedAuthorColor,
	authorColorsEnabled: boolean,
): ResolvedAuthorColor => {
	return authorColorsEnabled ? color : DEFAULT_HIGHLIGHT_COLOR;
};

export const resetAuthorColor = (assignments: AuthorColorAssignments, author: string): AuthorColorAssignment => {
	const key = canonicalAuthorKey(author);
	delete assignments[key];
	return ensureAuthorColor(assignments, key).assignment;
};
