import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { anchorRange } from "../format/parse";
import type { ParsedComment } from "../format/types";
import { commentConfig, type CommentConfig } from "./config";
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
type SourceTable = { start: number; end: number; from: number; to: number };

const OPEN_HIGHLIGHT = "document-comments-table";
const RESOLVED_HIGHLIGHT = "document-comments-table-resolved";
// `CSS.highlights` is a per-DOCUMENT global registry, so every editor view in a
// window must merge its ranges before we set it. Keyed by document (pop-out
// windows have their own) → each view's current ranges.
const rangesByDocument = new WeakMap<Document, Map<EditorView, TableRanges>>();

/** Map source comment anchors to the rendered table/cell that owns them. */
export const tableHighlightTargets = (doc: string, comments: ParsedComment[]): TableHighlightTarget[] => {
	const lines = sourceLines(doc);
	const targets: TableHighlightTarget[] = [];
	const tables = sourceTables(lines);

	for (const [table, { start, end }] of tables.entries()) {
		for (const comment of comments) {
			const range = anchorRange(comment);
			if (!range) continue;
			const lineIndex = lines.findIndex((line, index) => {
				if (index === start + 1 || index < start || index >= end) return false;
				return range.from >= line.from && range.to <= line.to;
			});
			const line = lines[lineIndex];
			if (!line) continue;

			const quote = doc.slice(range.from, range.to);
			if (!quote.trim()) continue;
			targets.push({
				table,
				row: lineIndex === start ? 0 : lineIndex - start - 1,
				column: tableColumnAt(line.text, range.from - line.from),
				quote,
				resolved: comment.status === "resolved",
			});
		}
	}

	return targets;
};

class TableHighlights {
	private observer: MutationObserver;
	private scheduled = false;
	private generation = 0;
	private renderedQuotes = new Map<string, Promise<string>>();

	constructor(private view: EditorView) {
		// Use the view's own window's MutationObserver so this works in a pop-out
		// window, whose globals differ from the main window's.
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
		this.generation++;
		this.observer.disconnect();
		setViewRanges(this.view, { open: [], resolved: [] }, true);
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			void this.refresh(++this.generation);
		});
	}

	private async refresh(generation: number): Promise<void> {
		const cfg = this.view.state.facet(commentConfig);
		const renderMarkdown = cfg.renderMarkdown;
		if (!cfg.showComments()) {
			setViewRanges(this.view, { open: [], resolved: [] });
			return;
		}

		const doc = this.view.state.doc.toString();
		const comments = getComments(this.view.state).filter(
			(comment) => cfg.showResolved() || comment.status !== "resolved",
		);
		const targets = tableHighlightTargets(doc, comments);
		const widgets = Array.from(this.view.dom.querySelectorAll<HTMLElement>(".cm-table-widget"));
		const widgetsByTable = mapTableWidgets(doc, widgets, (widget) => {
			try {
				return this.view.posAtDOM(widget);
			} catch {
				return null;
			}
		});
		const ranges: TableRanges = { open: [], resolved: [] };
		const nextMatch = new WeakMap<Element, number>();

		for (const target of targets) {
			const rows = widgetsByTable.get(target.table)?.querySelectorAll("tr");
			const row = rows?.item(target.row);
			const cells = row?.querySelectorAll<HTMLElement>("th, td");
			const cell = cells?.item(target.column);
			if (!cell) continue;

			const content =
				cell.querySelector<HTMLElement>(".cm-content") ??
				cell.querySelector<HTMLElement>(".table-cell-wrapper") ??
				cell;
			const from = nextMatch.get(content) ?? 0;
			const match = await textRangeForQuote(
				content,
				target.quote,
				from,
				renderMarkdown ? (quote) => this.renderedQuote(quote, renderMarkdown) : undefined,
			);
			if (generation !== this.generation) return;
			if (!match) continue;
			nextMatch.set(content, match.next);
			(target.resolved ? ranges.resolved : ranges.open).push(match.range);
		}

		if (generation === this.generation) setViewRanges(this.view, ranges);
	}

	private renderedQuote(
		quote: string,
		renderMarkdown: NonNullable<CommentConfig["renderMarkdown"]>,
	): Promise<string> {
		const cached = this.renderedQuotes.get(quote);
		if (cached) return cached;
		// Render once per quote and cache the promise itself (many table cells can
		// reference the same quote). Fall back to the raw quote if rendering fails.
		const render = async (): Promise<string> => {
			const root = this.view.dom.createDiv();
			root.remove();
			try {
				await renderMarkdown(quote, root);
				return textContent(root);
			} catch {
				return quote;
			}
		};
		const rendered = render();
		this.renderedQuotes.set(quote, rendered);
		return rendered;
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

export const textRange = (root: HTMLElement, needle: string, from: number): { range: Range; next: number } | null => {
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

export const textRangeForQuote = async (
	root: HTMLElement,
	quote: string,
	from: number,
	renderQuote?: (quote: string) => Promise<string>,
): Promise<{ range: Range; next: number } | null> => {
	const exact = textRange(root, quote, from);
	if (exact || !renderQuote) return exact;
	const rendered = await renderQuote(quote);
	return rendered && rendered !== quote ? textRange(root, rendered, from) : null;
};

const textContent = (root: HTMLElement): string => {
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	let text = "";
	let node = walker.nextNode() as Text | null;
	while (node) {
		text += node.data;
		node = walker.nextNode() as Text | null;
	}
	return text;
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

const sourceTables = (lines: Array<{ text: string; from: number; to: number }>): SourceTable[] => {
	// Scanner that consumes a variable run of rows per table and advances `start`
	// past it — a for loop is the natural fit, not an array method.
	const tables: SourceTable[] = [];
	for (let start = 0; start + 1 < lines.length; start++) {
		const head = lines[start];
		const delimiter = lines[start + 1];
		if (!head || !delimiter || !isTableRow(head.text) || !isDelimiterRow(delimiter.text)) continue;
		let end = start + 2;
		let row = lines[end];
		while (row && isTableRow(row.text)) {
			end++;
			row = lines[end];
		}
		const lastRow = lines[end - 1];
		if (!lastRow) continue;
		tables.push({ start, end, from: head.from, to: lastRow.to });
		start = end - 1;
	}
	return tables;
};

export const mapTableWidgets = <T>(
	doc: string,
	widgets: readonly T[],
	positionOf: (widget: T) => number | null,
): Map<number, T> => {
	const tables = sourceTables(sourceLines(doc));
	const result = new Map<number, T>();
	for (const widget of widgets) {
		const position = positionOf(widget);
		if (position === null) continue;
		const table = tables.findIndex(({ from, to }) => position >= from && position <= to);
		if (table >= 0) result.set(table, widget);
	}
	return result;
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
