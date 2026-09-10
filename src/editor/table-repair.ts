import { Result } from "better-result";
import { isCodeComment } from "../format/code-anchor";
import { anchorRange, parseComments } from "../format/parse";
import type { ParsedComment, TextRange } from "../format/types";
import { closeMarker, openMarker } from "../format/serialize";
import {
	clampToTableCells,
	isDelimiterLine,
	lineIndexAt,
	sourceLines,
	tableCoverage,
	type SourceLine,
} from "../format/table";
import type { Change } from "./edits";

/**
 * Finding and undoing the damage a comment written before the anchor clamp can
 * do to a table.
 *
 * A marker outside a row's outer pipes stops Obsidian reading that line as a
 * row, so the table truncates there — or, on the header or delimiter row, stops
 * rendering as a table at all. Nothing about the comment itself is wrong; the
 * markers just sit a few characters too far out, and moving them inside the
 * pipes restores the table.
 */

/** A blank-line-delimited block and the comments whose markers sit in it. */
type BlockAnchors = { block: TextRange; ids: Set<string> };
type Placement = TextRange & { id: string };

const ANCHOR_MARKER = /<!--\/?c:[A-Za-z0-9]+-->/;
const ANCHOR_MARKERS = /<!--\/?c:[A-Za-z0-9]+-->/g;

const stripMarkers = (text: string): string => text.replace(ANCHOR_MARKERS, "");

/** How many marker characters sit before `position` in `text`. */
const strippedBefore = (text: string, position: number): number => {
	return Array.from(text.matchAll(ANCHOR_MARKERS))
		.filter((match) => match.index < position)
		.reduce((removed, match) => removed + match[0].length, 0);
};

/** The text of the line holding `pos`, read without splitting the document. */
const lineTextAt = (doc: string, pos: number): string => {
	const end = doc.indexOf("\n", pos);
	return doc.slice(doc.lastIndexOf("\n", pos - 1) + 1, end < 0 ? doc.length : end);
};

/**
 * Whether removing the markers from a line changes whether it can take part in
 * a table. This is the cheap gate: pure string work on the marker's own line, run
 * over every comment on every document change. Nearly every note answers no here
 * and nothing in the document is scanned or split.
 */
const markersDamageLine = (text: string): boolean => {
	if (!ANCHOR_MARKER.test(text)) return false;
	const bare = stripMarkers(text);
	// A normal row must START with a pipe, a header must also END with one, a
	// delimiter row must be nothing but dashes and colons, and the line above a
	// table must be blank for it to render at all.
	if ((bare.trim() === "") !== (text.trim() === "")) return true;
	if (bare.startsWith("|") !== text.startsWith("|")) return true;
	if (/\|\s*$/.test(bare) !== /\|\s*$/.test(text)) return true;
	return isDelimiterLine(bare) !== isDelimiterLine(text);
};

/** The blank-line-delimited block holding `index`, or null for a line that
 *  doesn't exist. Tables never cross a blank line. */
const blockAround = (lines: readonly SourceLine[], index: number): TextRange | null => {
	if (!lines[index]) return null;
	const blank = lines.map((line) => line.text.trim() === "");
	// A negative fromIndex counts back from the end, so the first line needs a guard.
	const gapAbove = index > 0 ? blank.lastIndexOf(true, index - 1) : -1;
	const gapBelow = blank.indexOf(true, index + 1);
	const first = lines[gapAbove + 1];
	const last = lines[gapBelow < 0 ? lines.length - 1 : gapBelow - 1];
	return first && last ? { from: first.from, to: last.to } : null;
};

/** Group comment ids by the block their marker sits in. */
const groupByBlock = (
	lines: readonly SourceLine[],
	markers: ReadonlyArray<{ id: string; at: number }>,
): BlockAnchors[] => {
	const groups = markers.reduce((byStart, { id, at }) => {
		const block = blockAround(lines, lineIndexAt(lines, at));
		if (!block) return byStart;
		const group = byStart.get(block.from) ?? { block, ids: new Set<string>() };
		group.ids.add(id);
		return byStart.set(block.from, group);
	}, new Map<number, BlockAnchors>());
	return Array.from(groups.values());
};

/**
 * Rewrite one block with `ids`' anchors moved inside their table cells, or null
 * when it cannot be done safely.
 *
 * Every anchor in the block is reinserted, not just the repaired ones: the clamp
 * has to run against a block with ALL markers stripped, because a table broken
 * by two anchors only reappears once both are out of the way — and a healthy
 * neighbour's markers must come back exactly where they were.
 */
const repairedBlock = (doc: string, block: TextRange, ids: ReadonlySet<string>): string | null => {
	const text = doc.slice(block.from, block.to);
	const bare = stripMarkers(text);
	if (bare === text) return null;

	// A comment with no markers in the block — an orphan whose anchored text was
	// deleted, or a body whose anchor sits elsewhere — has nothing here to move.
	const anchored = parseComments(text).filter((comment) => comment.open || comment.close);
	const placements = anchored.map((comment): Placement | null => {
		const range = anchorRange(comment);
		// A lone marker has no range to restore, and stripping it would lose it.
		if (!range) return null;
		const from = range.from - strippedBefore(text, range.from);
		const to = range.to - strippedBefore(text, range.to);
		const target = ids.has(comment.id) ? clampToTableCells(bare, from, to) : { from, to };
		return target.to > target.from ? { id: comment.id, ...target } : null;
	});
	const placed = placements.filter((placement): placement is Placement => placement !== null);
	if (placed.length === 0 || placed.length < placements.length) return null;

	// Emit every marker as a point insertion in one forward pass. Splicing whole
	// anchors one at a time looks equivalent but silently corrupts nested ranges:
	// inserting an inner pair shifts the outer anchor's end, so its close marker
	// lands inside the inner one and both comments are destroyed. A whole-table
	// anchor around a cell comment — exactly what repair exists to undo — nests.
	const markers = placed.flatMap(({ id, from, to }) => [
		{ at: from, text: openMarker(id), closing: false, from, to },
		{ at: to, text: closeMarker(id), closing: true, from, to },
	]);
	markers.sort((a, b) => {
		if (a.at !== b.at) return a.at - b.at;
		// At a shared boundary a close comes before an open, so neighbouring anchors
		// read `…<!--/c:a--><!--c:b-->…` rather than interleaving.
		if (a.closing !== b.closing) return a.closing ? -1 : 1;
		// Innermost closes first and outermost opens first, so nesting stays nested.
		return a.closing ? b.from - a.from : b.to - a.to;
	});

	const rebuilt =
		markers.map((marker, index) => bare.slice(markers[index - 1]?.at ?? 0, marker.at) + marker.text).join("") +
		bare.slice(markers[markers.length - 1]?.at ?? 0);
	return rebuilt === text ? null : rebuilt;
};

/**
 * Ids whose anchor markers are breaking a table AND can be moved back inside it.
 *
 * Repairability is part of the test on purpose: a comment we cannot put right
 * should never be offered a Repair action that does nothing.
 */
export const brokenTableAnchors = (doc: string, parsed?: readonly ParsedComment[]): Set<string> => {
	// A code comment's markers sit on lines of their own around a fence by design,
	// so a line left blank by stripping them was never a gap a table relied on.
	const damaging = (parsed ?? parseComments(doc))
		.filter((comment) => !isCodeComment(comment))
		.flatMap((comment) =>
			[comment.open, comment.close]
				.filter((marker): marker is TextRange => marker !== null)
				.filter((marker) => markersDamageLine(lineTextAt(doc, marker.from)))
				.map((marker) => ({ id: comment.id, at: marker.from })),
		);
	if (damaging.length === 0) return new Set();

	// Blocks holding a marker that looks damaging, and the ids sitting in them.
	const suspects = groupByBlock(sourceLines(doc), damaging);

	// Confirm against the block only — a line can look damaging in prose that was
	// never a table. Scoped this way the check stays cheap even when it does run.
	const broken = suspects
		.filter(({ block }) => {
			const text = doc.slice(block.from, block.to);
			return tableCoverage(stripMarkers(text)) > tableCoverage(text);
		})
		.flatMap(({ block, ids }) => Array.from(ids).filter((id) => repairedBlock(doc, block, new Set([id])) !== null));
	return new Set(broken);
};

/** Rewrite every block whose table an anchor is breaking. `only` limits it to
 *  specific comments; without it, every repairable one in the document. */
export const computeRepairTableAnchors = (doc: string, only?: ReadonlySet<string>): Result<Change[], string> => {
	const targets = brokenTableAnchors(doc);
	const ids = only ? new Set([...targets].filter((id) => only.has(id))) : targets;
	if (ids.size === 0) return Result.ok([]);

	const blocks = groupByBlock(
		sourceLines(doc),
		parseComments(doc).flatMap((comment) => {
			const marker = comment.open ?? comment.close;
			return ids.has(comment.id) && marker ? [{ id: comment.id, at: marker.from }] : [];
		}),
	);

	const changes = blocks.flatMap(({ block, ids: blockIds }) => {
		const repaired = repairedBlock(doc, block, blockIds);
		return repaired === null ? [] : [{ from: block.from, to: block.to, insert: repaired }];
	});
	return Result.ok(changes.sort((a, b) => a.from - b.from));
};
