import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { anchorRange } from "../format/parse";
import type { ParsedComment, TextRange } from "../format/types";
import { type SourceLine, type SourceTable, sourceLines, sourceTables, tableColumnAt } from "../format/table";
import { commentConfig, type CommentConfig } from "./config";
import { getComments } from "./state";
import { authorColorCss, creatorForComment, type ResolvedAuthorColor } from "../author-colors";

/** A rendered table cell, addressed the way the widget's DOM is laid out. */
export type TableCellTarget = {
	table: number;
	row: number;
	column: number;
};

export type TableHighlightTarget = TableCellTarget & {
	id: string;
	quote: string;
	resolved: boolean;
	author: string | null;
};

type TableColorRanges = {
	color: ResolvedAuthorColor;
	resolved: boolean;
	active: boolean;
	ranges: Range[];
};
type TableRanges = Map<string, TableColorRanges>;
type BrowserWindow = NonNullable<Document["defaultView"]>;

// `CSS.highlights` is a per-DOCUMENT global registry, so every editor view in a
// window must merge its ranges before we set it. Keyed by document (pop-out
// windows have their own) → each view's current ranges.
const rangesByDocument = new WeakMap<Document, Map<EditorView, TableRanges>>();
const namesByDocument = new WeakMap<Document, Set<string>>();
const stylesByDocument = new WeakMap<Document, HTMLStyleElement>();

export const tableHighlightName = (color: ResolvedAuthorColor, resolved: boolean, active = false): string => {
	const state = `${resolved ? "resolved" : "open"}${active ? "-active" : ""}`;
	return `document-comments-table-${state}-${color ? color.slice(1) : "default"}`;
};

export const tableHighlightRule = (color: ResolvedAuthorColor, resolved: boolean, active = false): string => {
	const name = tableHighlightName(color, resolved, active);
	const cssColor = authorColorCss(color);
	// Mirror the DOM highlight's 18% / 38% pair, so hovering a card emphasizes
	// table text exactly as much as it emphasizes prose.
	const mix = (percent: number) => `color-mix(in srgb, ${cssColor} ${percent}%, transparent)`;
	const background = active ? mix(38) : resolved ? "transparent" : mix(18);
	const decoration = resolved ? "dashed" : "solid";
	return `::highlight(${name}) { background-color: ${background}; text-decoration-line: underline; text-decoration-style: ${decoration}; text-decoration-color: ${cssColor}; }`;
};

/** Map source comment anchors to the rendered table/cell that owns them. */
export const tableHighlightTargets = (doc: string, comments: ParsedComment[]): TableHighlightTarget[] => {
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	const targets: TableHighlightTarget[] = [];

	for (const comment of comments) {
		const range = anchorRange(comment);
		if (!range) continue;
		const quote = doc.slice(range.from, range.to);
		if (!quote.trim()) continue;
		const cell = tableCellTarget(lines, tables, range);
		// Only an anchor wholly inside one cell has text there to paint.
		if (!cell?.whole) continue;
		targets.push({
			table: cell.table,
			row: cell.row,
			column: cell.column,
			id: comment.id,
			quote,
			resolved: comment.status === "resolved",
			author: creatorForComment(comment),
		});
	}

	return targets;
};

/**
 * The table cell a source range starts in, or null when it starts in no table.
 * `whole` says whether the range also ENDS there — an anchor spanning two rows
 * has no single cell to paint, but its card still belongs beside the row it
 * starts on rather than at the top of the table.
 */
export const tableCellForRange = (doc: string, range: TextRange): (TableCellTarget & { whole: boolean }) | null => {
	const lines = sourceLines(doc);
	return tableCellTarget(lines, sourceTables(lines), range);
};

const tableCellTarget = (
	lines: readonly SourceLine[],
	tables: readonly SourceTable[],
	range: TextRange,
): (TableCellTarget & { whole: boolean }) | null => {
	for (const [table, { start, end }] of tables.entries()) {
		const lineIndex = lines.findIndex((line, index) => {
			if (index === start + 1 || index < start || index >= end) return false;
			return range.from >= line.from && range.from <= line.to;
		});
		const line = lines[lineIndex];
		if (!line) continue;
		return {
			table,
			// The delimiter row is skipped above, so body rows shift up by one.
			row: lineIndex === start ? 0 : lineIndex - start - 1,
			column: tableColumnAt(line.text, range.from - line.from),
			whole: range.to <= line.to,
		};
	}
	return null;
};

/**
 * The rendered `<th>`/`<td>` that owns each source range, keyed the way the
 * caller keyed the ranges. A key is absent when its range isn't inside a table,
 * or when Live Preview hasn't mounted that table's widget.
 *
 * The margin needs this because a Live-Preview table is a single block widget:
 * `coordsAtPos` reports the widget's own rect for every position inside it, so
 * measuring a card's anchor that way puts every card in a table on the table's
 * top edge instead of beside its row (issue #79).
 */
export const tableCellsForRanges = (
	view: EditorView,
	doc: string,
	ranges: ReadonlyMap<string, TextRange>,
): Map<string, HTMLElement> => {
	const cells = new Map<string, HTMLElement>();
	if (ranges.size === 0) return cells;
	const lines = sourceLines(doc);
	const tables = sourceTables(lines);
	if (tables.length === 0) return cells;

	const widgets = mountedTableWidgets(view, doc);
	for (const [key, range] of ranges) {
		const target = tableCellTarget(lines, tables, range);
		const cell = target && cellElement(widgets, target);
		if (cell) cells.set(key, cell);
	}
	return cells;
};

/** Mounted table widgets, keyed by their index in the source's table order. */
const mountedTableWidgets = (view: EditorView, doc: string): Map<number, HTMLElement> => {
	const widgets = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-table-widget"));
	return mapTableWidgets(doc, widgets, (widget) => {
		try {
			return view.posAtDOM(widget);
		} catch {
			return null;
		}
	});
};

const cellElement = (widgets: ReadonlyMap<number, HTMLElement>, target: TableCellTarget): HTMLElement | null => {
	const row = widgets.get(target.table)?.querySelectorAll("tr").item(target.row);
	return row?.querySelectorAll<HTMLElement>("th, td").item(target.column) ?? null;
};

class TableHighlights {
	private observer: MutationObserver;
	private scheduled = false;
	private generation = 0;
	private activeId: string | null = null;
	private painted = new Map<string, Range[]>();
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
		setViewRanges(this.view, new Map(), true);
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
			this.painted = new Map();
			setViewRanges(this.view, new Map());
			return;
		}

		const doc = this.view.state.doc.toString();
		const comments = getComments(this.view.state).filter(
			(comment) => cfg.showResolved() || comment.status !== "resolved",
		);
		const targets = tableHighlightTargets(doc, comments);
		const widgetsByTable = mountedTableWidgets(this.view, doc);
		const ranges: TableRanges = new Map();
		const painted = new Map<string, Range[]>();
		const nextMatch = new WeakMap<Element, number>();

		for (const target of targets) {
			const cell = cellElement(widgetsByTable, target);
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
			const color = (cfg.highlightColorForAuthor ?? cfg.colorForAuthor)(target.author ?? cfg.author());
			const active = target.id === this.activeId;
			const name = tableHighlightName(color, target.resolved, active);
			const entry = ranges.get(name) ?? { color, resolved: target.resolved, active, ranges: [] };
			entry.ranges.push(match.range);
			ranges.set(name, entry);
			painted.set(target.id, [...(painted.get(target.id) ?? []), match.range]);
		}

		if (generation !== this.generation) return;
		this.painted = painted;
		setViewRanges(this.view, ranges);
	}

	/** Emphasize one comment's table text (or none). Hovering a margin card and
	 *  hovering the text itself both land here. */
	setActiveComment(id: string | null): void {
		if (this.activeId === id) return;
		this.activeId = id;
		this.schedule();
	}

	/** The comment whose painted table text covers a point. A CSS Custom Highlight
	 *  has no element to hit-test, so ask its ranges for their rects instead. */
	commentAtPoint(x: number, y: number): string | null {
		const covers = (rect: DOMRect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
		for (const [id, ranges] of this.painted) {
			if (ranges.some((range) => Array.from(range.getClientRects()).some(covers))) return id;
		}
		return null;
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

/** Emphasize a comment's text inside this view's Live-Preview tables, or clear it. */
export const setActiveTableComment = (view: EditorView, id: string | null): void => {
	view.plugin(tableHighlightPlugin)?.setActiveComment(id);
};

/** The comment whose table text covers a viewport point, or null. */
export const tableCommentAtPoint = (view: EditorView, x: number, y: number): string | null => {
	return view.plugin(tableHighlightPlugin)?.commentAtPoint(x, y) ?? null;
};

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
	const merged = [...viewRanges.values()]
		.flatMap((entries) => [...entries.entries()])
		.reduce((all, [name, entry]) => {
			const existing = all.get(name) ?? { ...entry, ranges: [] };
			existing.ranges.push(...entry.ranges);
			all.set(name, existing);
			return all;
		}, new Map<string, TableColorRanges>());
	const previousNames = namesByDocument.get(doc) ?? new Set<string>();
	previousNames.forEach((name) => {
		if (!merged.has(name)) scope.CSS.highlights.delete(name);
	});
	merged.forEach((entry, name) => setHighlight(scope, name, entry.ranges));
	namesByDocument.set(doc, new Set(merged.keys()));
	updateHighlightStyles(doc, merged);
	if (viewRanges.size > 0) return;
	rangesByDocument.delete(doc);
};

const setHighlight = (scope: BrowserWindow, name: string, ranges: Range[]): void => {
	if (ranges.length === 0) scope.CSS.highlights.delete(name);
	else scope.CSS.highlights.set(name, new scope.Highlight(...ranges));
};

const updateHighlightStyles = (doc: Document, ranges: ReadonlyMap<string, TableColorRanges>): void => {
	if (ranges.size === 0) {
		stylesByDocument.get(doc)?.remove();
		stylesByDocument.delete(doc);
		return;
	}
	let style = stylesByDocument.get(doc);
	if (!style) {
		// CSS Custom Highlight ranges cannot carry per-range colors, so one scoped
		// runtime stylesheet per owner document is the only way to color its names.
		style = (doc.head ?? doc.documentElement).createEl("style");
		style.dataset.documentCommentsTableHighlights = "true";
		stylesByDocument.set(doc, style);
	}
	style.textContent = [...ranges.entries()]
		.map(([, entry]) => tableHighlightRule(entry.color, entry.resolved, entry.active))
		.join("\n");
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
