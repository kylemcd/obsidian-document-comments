import { App, Debouncer, ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";
import { Card, CardCallbacks, cardSignature } from "./card";
import {
	Change,
	applyChanges,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	computeToggleReaction,
} from "../editor/edits";
import { cssEscape } from "../util/css";
import { centeredScrollTop } from "./scroll";

export const COMMENTS_VIEW_TYPE = "document-comments-sidebar";

export type SidebarDeps = {
	app: App;
	getAuthor: () => string;
};

/** Panel-local status filter — independent of the document's resolved setting. */
type FilterMode = "open" | "resolved" | "all";

const FILTERS: ReadonlyArray<{ mode: FilterMode; label: string }> = [
	{ mode: "open", label: "Open" },
	{ mode: "resolved", label: "Resolved" },
	{ mode: "all", label: "All" },
];

/**
 * The "All discussions" panel: a dedicated side view listing the active note's
 * comments as Notion-style cards, with an Open / Resolved / All status filter.
 * While it's open the inline floating cards step aside (the plugin reads
 * `onMountedChange`); the in-text highlights stay. Edits route through the open
 * editor when there is one (so they join its undo history), else `vault.process`.
 */
export class CommentsSidebarView extends ItemView {
	private listEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private cards = new Map<string, Card>();
	private file: TFile | null = null;
	private cb: CardCallbacks;
	private scheduleRefresh: Debouncer<[], void>;
	private filter: FilterMode = "open";
	private tabs: Array<{ mode: FilterMode; el: HTMLElement; countEl: HTMLElement }> = [];
	private revealFrame: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private deps: SidebarDeps,
	) {
		super(leaf);
		this.scheduleRefresh = debounce(() => void this.refresh(), 60, true);
		this.cb = {
			getAuthor: () => deps.getAuthor(),
			onHover: (id, active) => this.markDocHighlight(id, active),
			onClickAnchor: (id) => this.scheduleRevealAnchor(id),
			onResize: () => {
				/* the panel uses normal flow — cards reflow on their own */
			},
			revealComposer: (id) => this.revealComposer(id),
			reply: (id, text) =>
				void this.edit((doc) =>
					computeAppendReply(doc, id, {
						createdAt: new Date().toISOString(),
						author: deps.getAuthor(),
						text,
					}),
				),
			setResolved: (id, resolved) => void this.edit((doc) => computeSetResolved(doc, id, resolved)),
			remove: (id) => void this.edit((doc) => computeDeleteComment(doc, id)),
			editEntry: (id, index, text) => void this.edit((doc) => computeEditEntry(doc, id, index, text)),
			deleteEntry: (id, index) => void this.edit((doc) => computeDeleteEntry(doc, id, index)),
			toggleReaction: (id, emoji) =>
				void this.edit((doc) => computeToggleReaction(doc, id, emoji, deps.getAuthor())),
		};
	}

	getViewType(): string {
		return COMMENTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Comments";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("dc-sidebar-view");

		const header = root.createDiv("dc-sidebar__header");
		this.titleEl = header.createDiv("dc-sidebar__title");

		// Panel-local status filter (Open / Resolved / All), each with a live count.
		const tabs = header.createDiv("dc-sidebar__tabs");
		this.tabs = FILTERS.map(({ mode, label }) => {
			const el = tabs.createEl("button", { cls: "dc-sidebar__tab" });
			el.createSpan({ text: label });
			const countEl = el.createSpan({ cls: "dc-sidebar__tab-count" });
			el.addEventListener("click", () => this.setFilter(mode));
			return { mode, el, countEl };
		});

		this.listEl = root.createDiv("dc-sidebar");
		this.emptyEl = root.createDiv("dc-sidebar__empty");

		// Follow the active note, its content, and external edits.
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (this.file && f.path === this.file.path) this.scheduleRefresh();
			}),
		);

		await this.refresh();
	}

	async onClose(): Promise<void> {
		if (this.revealFrame !== null) window.cancelAnimationFrame(this.revealFrame);
		for (const card of this.cards.values()) {
			card.destroy();
			card.el.remove();
		}
		this.cards.clear();
	}

	/** Public hook so the plugin can re-render after an external change. */
	requestRefresh(): void {
		this.scheduleRefresh();
	}

	/** Scroll the panel to a thread and flash it — the landing point when a too-tall
	 *  margin card escapes here. Switches to "All" so the thread is always shown. */
	async revealComment(id: string): Promise<void> {
		this.filter = "all";
		await this.refresh();
		const card = this.cards.get(id);
		if (!card) return;
		card.el.scrollIntoView({ block: "center", behavior: "smooth" });
		card.el.addClass("dc-flash");
		window.setTimeout(() => card.el.removeClass("dc-flash"), 1000);
	}

	/** Scroll the panel to reveal a just-opened reply composer. Centers it (the bottom
	 *  padding gives the last card room) so it isn't pinned at the cut-off bottom edge
	 *  and has space to grow as you type. */
	private revealComposer(id: string): void {
		const card = this.cards.get(id);
		if (!card) return;
		window.requestAnimationFrame(() => {
			card.el.querySelector(".dc-field--composer")?.scrollIntoView({ block: "center", behavior: "smooth" });
		});
	}

	private setFilter(mode: FilterMode): void {
		if (this.filter === mode) return;
		this.filter = mode;
		void this.refresh();
	}

	private async refresh(text?: string): Promise<void> {
		this.file = this.resolveFile();

		const file = this.file;
		if (!file) {
			this.renderComments([]);
			this.titleEl.setText("Comments");
			this.paintTabs({ open: 0, resolved: 0, all: 0 });
			this.setEmpty("Open a note to see its comments.");
			return;
		}

		let data: string;
		try {
			data = text ?? (await this.currentText(file));
		} catch {
			this.renderComments([]);
			this.titleEl.setText(file.basename);
			this.paintTabs({ open: 0, resolved: 0, all: 0 });
			this.setEmpty("Couldn't read this note.");
			return;
		}

		const all = parseComments(data).filter((c) => c.body);
		const open = all.filter((c) => c.status !== "resolved");
		const resolved = all.filter((c) => c.status === "resolved");
		const shown = this.filter === "open" ? open : this.filter === "resolved" ? resolved : all;

		this.titleEl.setText(file.basename);
		this.paintTabs({ open: open.length, resolved: resolved.length, all: all.length });
		this.renderComments(shown);
		this.setEmpty(this.emptyMessage(all.length, shown.length));
	}

	private emptyMessage(total: number, shown: number): string | null {
		if (shown > 0) return null;
		if (total === 0) return "No comments in this note yet.";
		if (this.filter === "open") return "No open comments.";
		if (this.filter === "resolved") return "No resolved comments.";
		return "Nothing to show.";
	}

	private paintTabs(counts: Record<FilterMode, number>): void {
		for (const tab of this.tabs) {
			const active = tab.mode === this.filter;
			tab.el.toggleClass("is-active", active);
			tab.el.setAttribute("aria-pressed", active ? "true" : "false");
			tab.countEl.setText(String(counts[tab.mode]));
		}
	}

	private renderComments(comments: ParsedComment[]): void {
		const present = new Set(comments.map((c) => c.id));
		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.destroy();
				card.el.remove();
				this.cards.delete(id);
			}
		}
		const cardView = { app: this.app, sourcePath: () => this.file?.path ?? "" };
		for (const c of comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				this.cards.set(c.id, new Card(c, this.cb, cardView));
			} else if (existing.signature !== cardSignature(c)) {
				existing.update(c);
			}
		}
		// Re-order the DOM to match document order — but only touch it when the
		// order actually differs, so an open composer doesn't lose focus on every
		// content refresh.
		const desired = comments.map((c) => this.cards.get(c.id)!.el);
		const current = Array.from(this.listEl.children);
		const sameOrder = desired.length === current.length && desired.every((el, i) => el === current[i]);
		if (!sameOrder) for (const el of desired) this.listEl.appendChild(el);
	}

	private setEmpty(message: string | null): void {
		this.emptyEl.toggleClass("is-hidden", message === null);
		this.emptyEl.setText(message ?? "");
	}

	// ── Edits ──────────────────────────────────────────────────────────────
	/** Apply a computed change set to the active note. Prefer the open editor
	 *  (keeps edits in its undo history and in sync with unsaved changes);
	 *  fall back to a direct file write for notes only shown in reading view. */
	private async edit(compute: (doc: string) => Result<Change[], string>): Promise<void> {
		const file = this.file;
		if (!file) return;
		const cm = this.editorViewForFile(file);
		if (cm) {
			compute(cm.state.doc.toString()).match({
				ok: (changes) => {
					cm.dispatch({ changes });
					void this.refresh();
				},
				err: (message) => new Notice(`Couldn't save the comment: ${message}`),
			});
			return;
		}
		let computeError: string | undefined;
		const io = await Result.tryPromise({
			try: () =>
				this.app.vault.process(file, (data) => {
					const result = compute(data);
					if (result.isErr()) {
						computeError = result.error;
						return data;
					}
					return applyChanges(data, result.value);
				}),
			catch: (e) => (e instanceof Error ? e.message : "unknown error"),
		});
		const outcome: Result<string, string> = computeError ? Result.err(computeError) : io;
		outcome.match({
			ok: (newData) => void this.refresh(newData),
			err: (message) => new Notice(`Couldn't save the comment: ${message}`),
		});
	}

	// ── Document interplay ─────────────────────────────────────────────────
	/** Let the sidebar card's mousedown/focus handling finish before moving the
	 *  document. Otherwise Obsidian can restore the old editor scroll position,
	 *  which was especially visible when navigating upward. */
	private scheduleRevealAnchor(id: string): void {
		if (this.revealFrame !== null) window.cancelAnimationFrame(this.revealFrame);
		this.revealFrame = window.requestAnimationFrame(() => {
			this.revealFrame = null;
			this.revealAnchor(id);
		});
	}

	private revealAnchor(id: string): void {
		const file = this.file;
		if (!file) return;
		const view = this.markdownViewForFile(file);
		if (!view) return;
		if (view.getMode() === "preview") {
			const span = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
			if (span instanceof HTMLElement) {
				span.scrollIntoView({ block: "center", behavior: "smooth" });
				this.flash(span);
			}
			return;
		}
		const cm = this.editorViewForFile(file);
		if (!cm) return;
		const c = parseComments(cm.state.doc.toString()).find((x) => x.id === id);
		if (!c) return;
		const r = anchorRange(c);
		const pos = r ? r.from : c.body?.from;
		if (pos == null) return;
		cm.requestMeasure({
			key: this,
			read: () => {
				const block = cm.lineBlockAt(pos);
				return centeredScrollTop(block.top, block.height, cm.scrollDOM.clientHeight, cm.scrollDOM.scrollHeight);
			},
			write: (top) => {
				cm.scrollDOM.scrollTo({ top, behavior: "smooth" });
				this.flashEditorAnchor(cm, id);
			},
		});
	}

	/** CodeMirror only mounts offscreen line DOM after scrolling begins. Poll for
	 *  a few frames so the destination can flash regardless of scroll direction. */
	private flashEditorAnchor(cm: EditorView, id: string, attempts = 0): void {
		window.requestAnimationFrame(() => {
			const span = cm.contentDOM.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
			if (span instanceof HTMLElement) {
				this.flash(span);
			} else if (attempts < 20) {
				this.flashEditorAnchor(cm, id, attempts + 1);
			}
		});
	}

	private markDocHighlight(id: string, active: boolean): void {
		const file = this.file;
		if (!file) return;
		const view = this.markdownViewForFile(file);
		if (!view) return;
		view.containerEl
			.querySelectorAll(`.doc-comment-span[data-cid="${cssEscape(id)}"]`)
			.forEach((s) => s.classList.toggle("is-active", active));
	}

	private flash(span: HTMLElement): void {
		span.addClass("dc-flash");
		window.setTimeout(() => span.removeClass("dc-flash"), 900);
	}

	// ── Resolving the active note + its live text ──────────────────────────
	private resolveFile(): TFile | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) return active.file;
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent?.view instanceof MarkdownView && recent.view.file) return recent.view.file;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file) return v.file;
		}
		return null;
	}

	private async currentText(file: TFile): Promise<string> {
		const cm = this.editorViewForFile(file);
		if (cm) return cm.state.doc.toString();
		return this.app.vault.read(file);
	}

	private editorViewForFile(file: TFile): EditorView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file === file && v.getMode() !== "preview") {
				const cm = (v.editor as unknown as { cm?: unknown }).cm;
				if (cm instanceof EditorView) return cm;
			}
		}
		return null;
	}

	private markdownViewForFile(file: TFile): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file === file) return v;
		}
		return null;
	}
}
