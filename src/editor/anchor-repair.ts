import { Result } from "better-result";
import { parseComments } from "../format/parse";
import type { ParsedComment } from "../format/types";
import type { Change } from "./edits";
import { brokenLineAnchors, computeRepairLineAnchors } from "./line-repair";
import { brokenTableAnchors, computeRepairTableAnchors } from "./table-repair";

/** What a comment's markers are breaking: its table, or the line one starts. */
export type AnchorDamage = "table" | "line";

/** Every comment whose markers are breaking the note in a way a repair can undo. */
export const anchorDamage = (doc: string, parsed?: readonly ParsedComment[]): Map<string, AnchorDamage> => {
	const comments = parsed ?? parseComments(doc);
	const damage = new Map<string, AnchorDamage>();
	brokenLineAnchors(doc, comments).forEach((id) => damage.set(id, "line"));
	// Breaking a table is the bigger problem, and its repair moves the markers anyway.
	brokenTableAnchors(doc, comments).forEach((id) => damage.set(id, "table"));
	return damage;
};

/** Repair every broken anchor, or only `only`'s. A line repair that a table repair
 *  overlaps is left for the next run, once the markers have settled into the cell. */
export const computeRepairAnchors = (doc: string, only?: ReadonlySet<string>): Result<Change[], string> => {
	const tables = computeRepairTableAnchors(doc, only);
	if (tables.isErr()) return tables;
	const lines = computeRepairLineAnchors(doc, only);
	if (lines.isErr()) return lines;
	const clear = (change: Change): boolean =>
		tables.value.every((table) => change.to < table.from || change.from > table.to);
	return Result.ok([...tables.value, ...lines.value.filter(clear)].sort((a, b) => a.from - b.from));
};
