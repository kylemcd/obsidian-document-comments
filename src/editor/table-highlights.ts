import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { anchorRange } from "../format/parse";
import type { ParsedComment } from "../format/types";
import { commentConfig } from "./config";
import { getComments } from "./state";

export type TableHighlightTarget = {
	table: number;
	row: number;
	column: number;
	quote: string;
	resolved: boolean;
};

type TableRanges = { open: Range[]; resolved: Range[] };
type BrowserWindow = NonNullable<Document["defaultView"]>;

const OPEN_HIGHLIGHT = "document-comments-table";
const RESOLVED_HIGHLIGHT = "document-comments-table-resolved";
const rangesByDocument = new WeakMap<Document, Map<EditorView, TableRanges>>();

/** Map source comment anchors to the rendered table/cell that owns them. */
export const tableHighlightTargets = (doc: string, comments: ParsedComment[]): TableHighlightTarget[] => {
	const lines = sourceLines(doc);
	const targets: TableHighlightTarget[] = [];
	let table = 0;

	for (let start = 0; start + 1 < lines.length; start++) {
		if (!isTableRow(lines[start].text) || !isDelimiterRow(lines[start + 1].text)) continue;

		let end = start + 2;
		while (end < lines.length && isTableRow(lines[end].text)) end++;

		for (const comment of comments) {
			const range = anchorRange(comment);
			if (!range) continue;
			const lineIndex = lines.findIndex((line, index) => {
				if (index === start + 1 || index < start || index >= end) return false;
				return range.from >= line.from && range.to <= line.to;
			});
			if (lineIndex < 0) continue;

			const quote = doc.slice(range.from, range.to);
			if (!quote.trim()) continue;
			targets.push({
				table,
				row: lineIndex === start ? 0 : lineIndex - start - 1,
				column: tableColumnAt(lines[lineIndex].text, range.from - lines[lineIndex].from),
				quote,
				resolved: comment.status === "resolved",
			});
		}

		table++;
		start = end - 1;
	}

	return targets;
};

class TableHighlights {
	private observer: MutationObserver;
	private scheduled = false;

	constructor(private view: EditorView) {
		const Observer = view.dom.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
		this.observer = new Observer(() => this.schedule());
		this.observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
		this.schedule();
	}

	update(_update: ViewUpdate): void {
		// Empty dispatches are used when settings change, so refresh on every update.
		this.schedule();
	}

	destroy(): void {
		this.observer.disconnect();
		setViewRanges(this.view, { open: [], resolved: [] }, true);
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.refresh();
		});
	}

	private refresh(): void {
		const cfg = this.view.state.facet(commentConfig);
		if (!cfg.showComments()) {
			setViewRanges(this.view, { open: [], resolved: [] });
			return;
		}

		const comments = getComments(this.view.state).filter(
			(comment) => cfg.showResolved() || comment.status !== "resolved",
		);
		const targets = tableHighlightTargets(this.view.state.doc.toString(), comments);
		const widgets = Array.from(this.view.dom.querySelectorAll<HTMLElement>(".cm-table-widget"));
		const ranges: TableRanges = { open: [], resolved: [] };
		const nextMatch = new WeakMap<Element, number>();

		for (const target of targets) {
			const rows = widgets[target.table]?.querySelectorAll("tr");
			const row = rows?.item(target.row);
			const cells = row?.querySelectorAll<HTMLElement>("th, td");
			const cell = cells?.item(target.column);
			if (!cell) continue;

			const content =
				cell.querySelector<HTMLElement>(".cm-content") ??
				cell.querySelector<HTMLElement>(".table-cell-wrapper") ??
				cell;
			const match = textRange(content, target.quote, nextMatch.get(content) ?? 0);
			if (!match) continue;
			nextMatch.set(content, match.next);
			(target.resolved ? ranges.resolved : ranges.open).push(match.range);
		}

		setViewRanges(this.view, ranges);
	}
}

export const tableHighlightPlugin = ViewPlugin.fromClass(TableHighlights);

const setViewRanges = (view: EditorView, ranges: TableRanges, remove = false): void => {
	const doc = view.dom.ownerDocument;
	let viewRanges = rangesByDocument.get(doc);
	if (!viewRanges) {
		viewRanges = new Map();
		rangesByDocument.set(doc, viewRanges);
	}
	if (remove) viewRanges.delete(view);
	else viewRanges.set(view, ranges);

	const scope = doc.defaultView;
	if (!scope?.CSS?.highlights || typeof scope.Highlight !== "function") return;
	const allOpen = Array.from(viewRanges.values()).flatMap((entry) => entry.open);
	const allResolved = Array.from(viewRanges.values()).flatMap((entry) => entry.resolved);
	setHighlight(scope, OPEN_HIGHLIGHT, allOpen);
	setHighlight(scope, RESOLVED_HIGHLIGHT, allResolved);
};

const setHighlight = (scope: BrowserWindow, name: string, ranges: Range[]): void => {
	if (ranges.length === 0) scope.CSS.highlights.delete(name);
	else scope.CSS.highlights.set(name, new scope.Highlight(...ranges));
};

const textRange = (root: HTMLElement, needle: string, from: number): { range: Range; next: number } | null => {
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	const nodes: Text[] = [];
	let text = "";
	let node = walker.nextNode() as Text | null;
	while (node) {
		nodes.push(node);
		text += node.data;
		node = walker.nextNode() as Text | null;
	}
	const index = text.indexOf(needle, from);
	if (index < 0) return null;

	const range = root.ownerDocument.createRange();
	let offset = 0;
	let started = false;
	for (const textNode of nodes) {
		const end = offset + textNode.data.length;
		if (!started && index >= offset && index <= end) {
			range.setStart(textNode, index - offset);
			started = true;
		}
		const matchEnd = index + needle.length;
		if (started && matchEnd >= offset && matchEnd <= end) {
			range.setEnd(textNode, matchEnd - offset);
			return { range, next: matchEnd };
		}
		offset = end;
	}
	return null;
};

const sourceLines = (doc: string): Array<{ text: string; from: number; to: number }> => {
	const lines: Array<{ text: string; from: number; to: number }> = [];
	let from = 0;
	for (const text of doc.split("\n")) {
		lines.push({ text, from, to: from + text.length });
		from += text.length + 1;
	}
	return lines;
};

const isTableRow = (line: string): boolean => unescapedPipes(line).length > 0;

const isDelimiterRow = (line: string): boolean => {
	const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
};

const tableColumnAt = (line: string, offset: number): number => {
	const pipes = unescapedPipes(line);
	const firstNonSpace = line.search(/\S/);
	const leadingPipe = pipes[0] === firstNonSpace ? pipes[0] : null;
	return pipes.filter((pipe) => pipe < offset && pipe !== leadingPipe).length;
};

const unescapedPipes = (line: string): number[] => {
	const pipes: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "|") continue;
		let slashes = 0;
		for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
		if (slashes % 2 === 0) pipes.push(i);
	}
	return pipes;
};
