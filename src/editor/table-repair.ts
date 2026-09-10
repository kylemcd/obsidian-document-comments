import { Result } from "better-result";
import { anchorRange, parseComments } from "../format/parse";
import type { ParsedComment } from "../format/types";
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

const ANCHOR_MARKER = /<!--\/?c:[A-Za-z0-9]+-->/;
const ANCHOR_MARKERS = /<!--\/?c:[A-Za-z0-9]+-->/g;

const stripMarkers = (text: string): string => text.replace(ANCHOR_MARKERS, "");

/** How many marker characters sit before `position` in `text`. */
const strippedBefore = (text: string, position: number): number => {
	let removed = 0;
	for (const match of text.matchAll(ANCHOR_MARKERS)) {
		if (match.index >= position) break;
		removed += match[0].length;
	}
	return removed;
};

/**
 * Whether removing the markers from a line changes whether it can take part in
 * a table. This is the cheap gate: pure string work, no table scanning, run over
 * every comment on every document change. Nearly every note answers no here and
 * the expensive confirmation below never runs.
 */
const markersDamageLine = (text: string): boolean => {
	if (!ANCHOR_MARKER.test(text)) return false;
	const bare = stripMarkers(text);
	// A normal row must START with a pipe, a header must also END with one, and a
	// delimiter row must be nothing but dashes and colons.
	if (bare.startsWith("|") !== text.startsWith("|")) return true;
	if (/\|\s*$/.test(bare) !== /\|\s*$/.test(text)) return true;
	return isDelimiterLine(bare) !== isDelimiterLine(text);
};

/** The blank-line-delimited block holding `index`. Tables never cross one. */
const blockAround = (lines: readonly SourceLine[], index: number): { from: number; to: number } => {
	let first = index;
	while (first > 0 && (lines[first - 1]?.text.trim() ?? "") !== "") first--;
	let last = index;
	while (last + 1 < lines.length && (lines[last + 1]?.text.trim() ?? "") !== "") last++;
	return { from: lines[first]!.from, to: lines[last]!.to };
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
const repairedBlock = (doc: string, block: { from: number; to: number }, ids: ReadonlySet<string>): string | null => {
	const text = doc.slice(block.from, block.to);
	const bare = stripMarkers(text);
	if (bare === text) return null;

	const placements: Array<{ id: string; from: number; to: number }> = [];
	for (const comment of parseComments(text)) {
		const range = anchorRange(comment);
		// A lone marker has no range to restore, and stripping it would lose it.
		if (!range) return null;
		const from = range.from - strippedBefore(text, range.from);
		const to = range.to - strippedBefore(text, range.to);
		const target = ids.has(comment.id) ? clampToTableCells(bare, from, to) : { from, to };
		if (target.to <= target.from) return null;
		placements.push({ id: comment.id, from: target.from, to: target.to });
	}
	if (placements.length === 0) return null;

	// Emit every marker as a point insertion in one forward pass. Splicing whole
	// anchors one at a time looks equivalent but silently corrupts nested ranges:
	// inserting an inner pair shifts the outer anchor's end, so its close marker
	// lands inside the inner one and both comments are destroyed. A whole-table
	// anchor around a cell comment — exactly what repair exists to undo — nests.
	const markers = placements.flatMap(({ id, from, to }) => [
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

	let out = "";
	let cursor = 0;
	for (const marker of markers) {
		out += bare.slice(cursor, marker.at) + marker.text;
		cursor = marker.at;
	}
	out += bare.slice(cursor);
	return out === text ? null : out;
};

/**
 * Ids whose anchor markers are breaking a table AND can be moved back inside it.
 *
 * Repairability is part of the test on purpose: a comment we cannot put right
 * should never be offered a Repair action that does nothing.
 */
export const brokenTableAnchors = (doc: string, parsed?: readonly ParsedComment[]): Set<string> => {
	const broken = new Set<string>();
	const comments = parsed ?? parseComments(doc);
	if (comments.length === 0) return broken;
	const lines = sourceLines(doc);

	// Blocks holding a marker that looks damaging, and the ids sitting in them.
	const suspects = new Map<number, { block: { from: number; to: number }; ids: Set<string> }>();
	for (const comment of comments) {
		for (const marker of [comment.open, comment.close]) {
			if (!marker) continue;
			const index = lineIndexAt(lines, marker.from);
			const line = lines[index];
			if (!line || !markersDamageLine(line.text)) continue;
			const block = blockAround(lines, index);
			const entry = suspects.get(block.from) ?? { block, ids: new Set<string>() };
			entry.ids.add(comment.id);
			suspects.set(block.from, entry);
		}
	}

	// Confirm against the block only — a line can look damaging in prose that was
	// never a table. Scoped this way the check stays cheap even when it does run.
	for (const { block, ids } of suspects.values()) {
		const text = doc.slice(block.from, block.to);
		if (tableCoverage(stripMarkers(text)) <= tableCoverage(text)) continue;
		for (const id of ids) {
			if (repairedBlock(doc, block, new Set([id])) !== null) broken.add(id);
		}
	}
	return broken;
};

/** Rewrite every block whose table an anchor is breaking. `only` limits it to
 *  specific comments; without it, every repairable one in the document. */
export const computeRepairTableAnchors = (doc: string, only?: ReadonlySet<string>): Result<Change[], string> => {
	const targets = brokenTableAnchors(doc);
	const ids = only ? new Set([...targets].filter((id) => only.has(id))) : targets;
	if (ids.size === 0) return Result.ok([]);

	const lines = sourceLines(doc);
	const blocks = new Map<number, { block: { from: number; to: number }; ids: Set<string> }>();
	for (const comment of parseComments(doc)) {
		if (!ids.has(comment.id)) continue;
		const marker = comment.open ?? comment.close;
		if (!marker) continue;
		const block = blockAround(lines, lineIndexAt(lines, marker.from));
		const entry = blocks.get(block.from) ?? { block, ids: new Set<string>() };
		entry.ids.add(comment.id);
		blocks.set(block.from, entry);
	}

	const changes = [...blocks.values()].flatMap(({ block, ids: blockIds }) => {
		const repaired = repairedBlock(doc, block, blockIds);
		return repaired === null ? [] : [{ from: block.from, to: block.to, insert: repaired }];
	});
	return Result.ok(changes.sort((a, b) => a.from - b.from));
};
