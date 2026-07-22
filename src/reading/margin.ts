import { App, MarkdownView, Notice } from "obsidian";
import { Result } from "better-result";
import { ParsedComment, TextRange } from "../format/types";
import { hasMarginAnchor, parseComments } from "../format/parse";
import { Card, CardCallbacks } from "../ui/card";
import { cardSignature } from "../ui/card-format";
import {
	Change,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	computeToggleReaction,
} from "../editor/edits";
import { applyCommentEdit, insertComment as routeInsertComment } from "../editor/routing";
import { closestSpanId, spanSelector } from "../util/css";
import { stackTops } from "../ui/stack";
import { CARD_GAP, FLASH_MS } from "../ui/constants";
import { buildDraftComposer } from "../ui/draft-composer";

export type ReadingDeps = {
	app: App;
	getAuthor: () => string;
	showComments: () => boolean;
	showResolved: () => boolean;
	/** While the sidebar panel is open, the inline column steps aside. */
	sidebarOpen: () => boolean;
	/** Reveal a thread in the sidebar — used by a margin card too tall to fit. */
	openInSidebar?: (id: string) => void;
	/** True on Obsidian mobile — no floating column; just drive highlight visibility. */
	isMobile?: () => boolean;
};

/** A margin column for one reading-view container, aligned to highlight spans. */
class ReadingMargin {
	private container: HTMLElement;
	private scroller: HTMLElement;
	private cards = new Map<string, Card>();
	private comments: ParsedComment[] = [];
	private activeId: string | null = null;
	private draft: TextRange | null = null;
	private draftText = "";
	private draftEl: HTMLElement | null = null;
	private draftAnchor: HTMLElement | null = null;
	private cb: CardCallbacks;
	private scrollHandler = () => this.position();
	private resizeObserver: ResizeObserver;
	private animFrames = 0;
	private animatingLoop = false;
	private destroyed = false;

	constructor(
		private readingView: HTMLElement,
		private view: MarkdownView,
		private deps: ReadingDeps,
	) {
		this.container = readingView.createDiv("doc-comment-margin");
		this.scroller = (readingView.querySelector(".markdown-preview-view") as HTMLElement) ?? readingView;
		this.cb = {
			getAuthor: () => deps.getAuthor(),
			onHover: (id, active) => this.setActive(active ? id : null),
			onClickAnchor: (id) => this.flashAnchor(id),
			onResize: () => this.position(),
			animateLayout: () => this.animateLayout(),
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
			openInSidebar: (id) => deps.openInSidebar?.(id),
		};

		this.scroller.addEventListener("scroll", this.scrollHandler, { passive: true });
		this.resizeObserver = new ResizeObserver(() => this.position());
		this.resizeObserver.observe(this.scroller);
		this.readingView.addEventListener("mouseover", this.onMouseOver);
		this.readingView.addEventListener("mouseout", this.onMouseOut);
		this.readingView.addEventListener("mousedown", this.onMouseDown);
	}

	async refresh(text?: string): Promise<void> {
		const file = this.view.file;
		if (!file) return;
		let data: string;
		try {
			// Use the caller's just-written content if given; otherwise read fresh (NOT
			// cachedRead, which can lag right after a write and show stale state).
			data = text ?? (await this.deps.app.vault.read(file));
		} catch {
			return; // file vanished or unreadable — keep the last render
		}
		const all = parseComments(data).filter(hasMarginAnchor);
		// Sidebar open → inline cards step aside (the panel lists them instead).
		this.comments = this.deps.showComments() && !this.deps.sidebarOpen() ? all : [];
		this.reconcileCards();
		this.position();
	}

	private async edit(compute: (doc: string) => Result<Change[], string>): Promise<void> {
		const file = this.view.file;
		if (!file) return;
		// Route through the open editor when there is one (undo history + unsaved
		// buffer) instead of a bare disk write that races the editor's autosave.
		(await applyCommentEdit(this.deps.app, file, compute)).match({
			ok: (newData) => void this.refresh(newData),
			err: (message) => new Notice(`Couldn't save the comment: ${message}`),
		});
	}

	private reconcileCards(): void {
		const present = new Set(this.comments.map((c) => c.id));
		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.destroy();
				card.el.remove();
				this.cards.delete(id);
				if (this.activeId === id) this.activeId = null;
			}
		}
		const cardView = { app: this.deps.app, sourcePath: () => this.view.file?.path ?? "", collapsible: true };
		for (const c of this.comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				const card = new Card(c, this.cb, cardView);
				this.cards.set(c.id, card);
				this.container.appendChild(card.el);
			} else if (existing.signature !== cardSignature(c)) {
				existing.update(c);
			}
		}
		this.readingView.toggleClass("dc-hide-resolved", !this.deps.showResolved());
	}

	private position(): void {
		if (this.destroyed) return;
		// State classes live on the reading-view container (Obsidian-owned, safe to
		// write directly), so the stylesheet caps the text column with plain
		// descendant selectors instead of :has().
		//
		// `dc-has` reserves the column (caps the sizer) and is tied ONLY to persistent
		// cards — never the transient draft composer. Reserving it for a draft reflowed
		// (and re-centered) the whole preview every time you opened/closed the composer
		// (issue #15). `dc-margin` is the lighter "the floating column is present"
		// signal: it just makes the container `position: relative` so the absolutely
		// positioned composer has a containing block (unlike the editor, CodeMirror
		// doesn't force position on the reading-view element). The composer then floats
		// over the right gutter without shifting the text.
		// Only a comment whose card actually renders reserves the column. A resolved
		// comment's card is `display:none` while resolved are hidden (dc-hide-resolved),
		// so counting it kept the empty column around once every comment was resolved
		// (issue #30) — mirror that visibility, exactly as the editor layout does.
		const hasCards = this.comments.some((c) => this.deps.showResolved() || c.status !== "resolved");
		this.readingView.toggleClass("dc-has", hasCards);
		this.readingView.toggleClass("dc-margin", hasCards || !!this.draft);
		// Highlights follow the master toggle alone, so they persist while the
		// sidebar panel hosts the cards (dc-has is off, dc-highlights stays on).
		this.readingView.toggleClass("dc-highlights", this.deps.showComments());
		const topRef = this.readingView.getBoundingClientRect().top;
		// Gather geometry (reads) first, then write every top in one pass — cards are
		// absolutely positioned, so a top write can't change any height.
		const placements: Array<{ el: HTMLElement; top: number; height: number }> = [];
		for (const c of this.comments) {
			const card = this.cards.get(c.id);
			if (!card) continue;
			const span = this.scroller.querySelector(spanSelector(c.id));
			if (!span) {
				card.el.addClass("dc-offscreen");
				continue;
			}
			card.el.removeClass("dc-offscreen");
			if (card.el.offsetHeight === 0) continue;
			placements.push({
				el: card.el,
				top: span.getBoundingClientRect().top - topRef,
				height: card.el.offsetHeight,
			});
		}
		if (this.draftEl && this.draftAnchor) {
			placements.push({
				el: this.draftEl,
				top: this.draftAnchor.getBoundingClientRect().top - topRef,
				height: this.draftEl.offsetHeight,
			});
		}
		const tops = stackTops(placements, CARD_GAP);
		placements.forEach((p, i) => p.el.setCssStyles({ top: `${tops[i]}px` }));
	}

	/** Show an inline draft composer for a new comment (Reading-view "Add").
	 *  `expected` is the source text at [from,to], verified when the write lands. */
	showDraft(from: number, to: number, range: Range, expected: string): void {
		this.clearDraft();
		const span = this.scroller.createSpan({ cls: "doc-comment-span dc-draft" });
		span.detach();
		try {
			range.surroundContents(span);
		} catch {
			new Notice("Select within a single paragraph to comment in reading view.");
			return;
		}
		this.draftAnchor = span;
		this.draft = { from, to };
		this.draftText = expected;
		this.draftEl = this.buildDraftEl();
		this.container.appendChild(this.draftEl);
		this.position();
		window.setTimeout(() => {
			const ta = this.draftEl?.querySelector("textarea");
			if (ta instanceof HTMLTextAreaElement) ta.focus();
		}, 0);
	}

	private buildDraftEl(): HTMLElement {
		const { el } = buildDraftComposer({
			onCancel: () => this.clearDraft(),
			onSubmit: (text) => {
				const draft = this.draft;
				const expected = this.draftText;
				this.clearDraft();
				if (text && draft) void this.insertComment(draft.from, draft.to, text, expected);
			},
		});
		return el;
	}

	private async insertComment(from: number, to: number, text: string, expected: string): Promise<void> {
		const file = this.view.file;
		if (!file) return;
		(await routeInsertComment(this.deps.app, file, from, to, text, this.deps.getAuthor(), expected)).match({
			ok: () => void this.refresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
	}

	private clearDraft(): void {
		if (this.draftAnchor) {
			// Unwrap the temp highlight span, restoring the original text nodes.
			const parent = this.draftAnchor.parentNode;
			if (parent) {
				while (this.draftAnchor.firstChild) parent.insertBefore(this.draftAnchor.firstChild, this.draftAnchor);
				parent.removeChild(this.draftAnchor);
				parent.normalize();
			}
			this.draftAnchor = null;
		}
		this.draftEl?.remove();
		this.draftEl = null;
		this.draft = null;
		this.draftText = "";
		// Re-run layout so the composer's `dc-margin` (and its reserved slot in the
		// stack) is dropped immediately on cancel — the editor margin gets this for
		// free via its dispatch cycle; the reading margin has to ask for it.
		this.position();
	}

	private setActive(id: string | null): void {
		if (this.activeId === id) return;
		if (this.activeId) {
			this.cards.get(this.activeId)?.setActive(false);
			this.markHighlight(this.activeId, false);
		}
		this.activeId = id;
		if (id) {
			this.cards.get(id)?.setActive(true);
			this.markHighlight(id, true);
		}
	}

	private markHighlight(id: string, active: boolean): void {
		this.scroller.querySelectorAll(spanSelector(id)).forEach((s) => s.classList.toggle("is-active", active));
	}

	/** Clicking a margin card flashes its highlighted text — no scroll (it's aligned). */
	private flashAnchor(id: string): void {
		this.setActive(id);
		const span = this.scroller.querySelector(spanSelector(id));
		if (!span) return;
		span.classList.add("dc-flash");
		window.setTimeout(() => span.classList.remove("dc-flash"), FLASH_MS);
	}

	/** Scroll the reading view the minimum needed to reveal a just-opened composer. */
	private revealComposer(id: string): void {
		const card = this.cards.get(id);
		if (!card) return;
		window.requestAnimationFrame(() => {
			const box = card.el.querySelector(".dc-field--composer");
			if (!(box instanceof HTMLElement)) return;
			const c = box.getBoundingClientRect();
			const s = this.scroller.getBoundingClientRect();
			let delta = 0;
			if (c.bottom > s.bottom) delta = c.bottom - s.bottom + 12;
			else if (c.top < s.top) delta = c.top - s.top - 12;
			if (delta) this.scroller.scrollTop += delta;
		});
	}

	/** Drive the stacking for a few frames so neighbors follow a card's open/close
	 *  height animation smoothly (mirrors the editor margin). */
	private animateLayout(): void {
		this.animFrames = 14;
		this.position();
		if (this.animatingLoop) return;
		this.animatingLoop = true;
		const tick = (): void => {
			this.position();
			if (this.animFrames-- > 0) {
				window.requestAnimationFrame(tick);
			} else {
				this.animatingLoop = false;
			}
		};
		window.requestAnimationFrame(tick);
	}

	private onMouseOver = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	private onMouseOut = (e: MouseEvent): void => {
		const span = e.target instanceof Element ? e.target.closest(".doc-comment-span") : null;
		if (!span) return;
		const to = e.relatedTarget;
		if (to instanceof Node && span.contains(to)) return;
		this.setActive(null);
	};

	private onMouseDown = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	destroy(): void {
		this.destroyed = true;
		this.clearDraft();
		this.scroller.removeEventListener("scroll", this.scrollHandler);
		this.resizeObserver.disconnect();
		this.readingView.removeEventListener("mouseover", this.onMouseOver);
		this.readingView.removeEventListener("mouseout", this.onMouseOut);
		this.readingView.removeEventListener("mousedown", this.onMouseDown);
		// The container we own goes away; the state classes sit on Obsidian's
		// reading-view element, so clear them explicitly to avoid leaving it capped.
		this.readingView.removeClasses(["dc-has", "dc-margin", "dc-highlights", "dc-hide-resolved"]);
		for (const card of this.cards.values()) card.destroy();
		this.container.remove();
		this.cards.clear();
	}
}

/** Tracks one ReadingMargin per reading-view container, creating/destroying as
 *  markdown leaves enter/leave preview mode. */
export class ReadingMarginManager {
	private margins = new Map<HTMLElement, ReadingMargin>();

	constructor(private deps: ReadingDeps) {}

	refresh(): void {
		const mobile = this.deps.isMobile?.() ?? false;
		const active = new Set<HTMLElement>();
		for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== "preview") continue;
			const rv = view.containerEl.querySelector(".markdown-reading-view");
			if (!(rv instanceof HTMLElement)) continue;
			active.add(rv);
			if (mobile) {
				// Mobile: no floating cards or reserved column. Just keep the in-text
				// highlights' visibility in sync with the toggles (no `dc-has`, so the
				// text keeps full width). Comments are read/created via the sidebar.
				rv.toggleClass("dc-highlights", this.deps.showComments());
				rv.toggleClass("dc-hide-resolved", !this.deps.showResolved());
				rv.removeClasses(["dc-has", "dc-margin"]);
				continue;
			}
			let margin = this.margins.get(rv);
			if (!margin) {
				margin = new ReadingMargin(rv, view, this.deps);
				this.margins.set(rv, margin);
			}
			void margin.refresh();
		}
		for (const [rv, margin] of this.margins) {
			if (!active.has(rv)) {
				margin.destroy();
				this.margins.delete(rv);
			}
		}
	}

	/** Show the inline new-comment composer on the active reading view. */
	startDraft(view: MarkdownView, from: number, to: number, range: Range, expected: string): void {
		const rv = view.containerEl.querySelector(".markdown-reading-view");
		if (!(rv instanceof HTMLElement)) return;
		let margin = this.margins.get(rv);
		if (!margin) {
			margin = new ReadingMargin(rv, view, this.deps);
			this.margins.set(rv, margin);
			void margin.refresh();
		}
		margin.showDraft(from, to, range, expected);
	}

	destroy(): void {
		for (const margin of this.margins.values()) margin.destroy();
		this.margins.clear();
	}
}
