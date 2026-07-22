import { Notice, editorInfoField } from "obsidian";
import { Result } from "better-result";
import { EditorView, PluginValue, ViewPlugin } from "@codemirror/view";
import { ParsedComment } from "../format/types";
import { anchorRange, hasMarginAnchor } from "../format/parse";
import { commentField } from "./state";
import { commentConfig } from "./config";
import { Draft, clearDraft, draftField } from "./draft";
import { Card, CardCallbacks, CardView } from "../ui/card";
import { cardSignature } from "../ui/card-format";
import {
	addComment,
	appendReply,
	deleteComment,
	deleteEntry,
	editEntry,
	setResolved,
	toggleReaction,
} from "./commands";
import { closestSpanId, spanSelector } from "../util/css";
import { stackTops } from "../ui/stack";
import { CARD_GAP, FLASH_MS } from "../ui/constants";
import { buildDraftComposer } from "../ui/draft-composer";

/** Editor-margin writes go through a live CodeMirror view (no I/O), so the only
 *  failure is a compute error — surface it as a notice rather than swallowing it. */
const notifyErr = (result: Result<unknown, string>): void => {
	if (result.isErr()) new Notice(`Couldn't save the comment: ${result.error}`);
};
/**
 * Renders the floating right-margin column: one card per comment, vertically
 * aligned to its anchor line, with a stacking pass so cards never overlap.
 */
class MarginView implements PluginValue {
	private container: HTMLElement;
	private cards = new Map<string, Card>();
	private activeId: string | null = null;
	private draftEl: HTMLElement | null = null;
	private draftFocused = false;
	private draftOutside: ((e: MouseEvent) => void) | null = null;
	private cb: CardCallbacks;
	private scrollHandler = () => this.requestReposition();
	private resizeObserver: ResizeObserver;
	private animFrames = 0;
	private animatingLoop = false;
	private destroyed = false;

	constructor(private view: EditorView) {
		this.container = view.dom.createDiv("doc-comment-margin");
		// The container lives inside .cm-editor, so CodeMirror would otherwise
		// intercept clicks/keystrokes meant for our textareas and buttons. Stop
		// those events at the container so our inputs behave like normal inputs.
		const stop = (e: Event) => e.stopPropagation();
		for (const type of [
			"mousedown",
			"mouseup",
			"click",
			"dblclick",
			"keydown",
			"keyup",
			"input",
			"beforeinput",
			"paste",
			"cut",
			"contextmenu",
		]) {
			this.container.addEventListener(type, stop);
		}
		this.cb = {
			getAuthor: () => view.state.facet(commentConfig).author(),
			onHover: (id, active) => this.setActive(active ? id : null),
			onClickAnchor: (id) => this.flashAnchor(id),
			onResize: () => this.reposition(),
			animateLayout: () => this.animateLayout(),
			revealComposer: (id) => this.revealComposer(id),
			reply: (id, text) => notifyErr(appendReply(view, id, text, this.cb.getAuthor())),
			setResolved: (id, resolved) => notifyErr(setResolved(view, id, resolved)),
			remove: (id) => notifyErr(deleteComment(view, id)),
			editEntry: (id, index, text) => notifyErr(editEntry(view, id, index, text)),
			deleteEntry: (id, index) => notifyErr(deleteEntry(view, id, index)),
			toggleReaction: (id, emoji) => notifyErr(toggleReaction(view, id, emoji, this.cb.getAuthor())),
			openInSidebar: (id) => view.state.facet(commentConfig).openInSidebar?.(id),
		};

		view.scrollDOM.addEventListener("scroll", this.scrollHandler, { passive: true });
		this.resizeObserver = new ResizeObserver(() => this.requestReposition());
		this.resizeObserver.observe(view.scrollDOM);
		view.contentDOM.addEventListener("mousedown", this.onContentMouseDown);
		view.contentDOM.addEventListener("mouseover", this.onContentMouseOver);
		view.contentDOM.addEventListener("mouseout", this.onContentMouseOut);

		this.reconcile();
		this.requestReposition();
	}

	update(): void {
		// Reconcile (pure DOM — safe during the update cycle), then schedule the
		// geometry-dependent reposition for the measure phase. coordsAtPos throws if
		// called during an update/construction, so positioning MUST go through
		// requestMeasure. The key also coalesces bursts into one measure per frame.
		this.reconcile();
		this.requestReposition();
	}

	private requestReposition(): void {
		this.view.requestMeasure({ key: this, read: () => this.reposition() });
	}

	/** Drive the stacking for a few frames so neighbors follow a card's open/close
	 *  height animation smoothly (vs. snapping to the final layout). */
	private animateLayout(): void {
		this.animFrames = 14;
		this.reposition();
		if (this.animatingLoop) return;
		this.animatingLoop = true;
		const tick = (): void => {
			this.reposition();
			if (this.animFrames-- > 0) {
				window.requestAnimationFrame(tick);
			} else {
				this.animatingLoop = false;
			}
		};
		window.requestAnimationFrame(tick);
	}

	destroy(): void {
		this.destroyed = true;
		this.view.scrollDOM.removeEventListener("scroll", this.scrollHandler);
		this.resizeObserver.disconnect();
		this.view.contentDOM.removeEventListener("mousedown", this.onContentMouseDown);
		this.view.contentDOM.removeEventListener("mouseover", this.onContentMouseOver);
		this.view.contentDOM.removeEventListener("mouseout", this.onContentMouseOut);
		this.removeDraftOutside();
		for (const card of this.cards.values()) card.destroy();
		this.cards.clear();
		this.container.remove();
	}

	private comments(): ParsedComment[] {
		const cfg = this.view.state.facet(commentConfig);
		// When the sidebar panel is open the comments live there, so the inline
		// column steps aside (no cards, no reserved width). Highlights persist —
		// they're keyed on `dc-highlights`, which still follows showComments.
		if (!cfg.showComments() || cfg.sidebarOpen()) return [];
		const fv = this.view.state.field(commentField, false);
		if (!fv) return [];
		// Resolved cards stay in the DOM and are hidden via a container class, so
		// toggling visibility never requires rebuilding the editor.
		return fv.comments.filter(hasMarginAnchor);
	}

	private reconcile(): void {
		const comments = this.comments();
		const present = new Set(comments.map((c) => c.id));

		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.destroy();
				card.el.remove();
				this.cards.delete(id);
				if (this.activeId === id) this.activeId = null;
			}
		}

		const cardView = this.cardView();
		for (const c of comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				const card = new Card(c, this.cb, cardView);
				this.cards.set(c.id, card);
				this.container.appendChild(card.el);
			} else if (existing.signature !== cardSignature(c)) {
				existing.update(c);
			}
		}
	}

	private cardView(): CardView {
		const cfg = this.view.state.facet(commentConfig);
		// Resolve links/embeds in comment text against THIS editor's file, not the
		// workspace-active one (wrong in a background split pane).
		return {
			app: cfg.app,
			sourcePath: () => this.view.state.field(editorInfoField, false)?.file?.path ?? "",
			collapsible: true,
		};
	}

	private reposition(): void {
		if (this.destroyed) return;
		// dc-has / dc-highlights / dc-hide-resolved now live on the .cm-editor element
		// (editorLayoutField → editorAttributes), so the stylesheet caps the text
		// column with plain descendant selectors — no :has(), nothing to toggle on our
		// own container here.
		const draft = this.view.state.field(draftField, false) ?? null;
		this.syncDraftEl(draft);

		const editorTop = this.view.dom.getBoundingClientRect().top;
		// Gather geometry (reads) first, then write every top in one pass — cards are
		// absolutely positioned, so a top write can't change any height.
		const placements: Array<{ el: HTMLElement; top: number; height: number }> = [];

		const place = (el: HTMLElement, pos: number) => {
			const coords = this.view.coordsAtPos(pos);
			if (!coords) {
				el.addClass("dc-offscreen");
				return;
			}
			el.removeClass("dc-offscreen");
			if (el.offsetHeight === 0) return; // hidden (e.g. resolved)
			placements.push({ el, top: coords.top - editorTop, height: el.offsetHeight });
		};

		for (const c of this.comments()) {
			const card = this.cards.get(c.id);
			if (!card) continue;
			const range = anchorRange(c);
			if (range) place(card.el, range.from);
		}

		if (draft && this.draftEl) place(this.draftEl, draft.from);

		const tops = stackTops(placements, CARD_GAP);
		placements.forEach((p, i) => p.el.setCssStyles({ top: `${tops[i]}px` }));
	}

	/** Create/remove the transient "new comment" composer card. */
	private syncDraftEl(draft: Draft | null): void {
		if (draft && !this.draftEl) {
			this.draftEl = this.buildDraftEl();
			this.container.appendChild(this.draftEl);
			this.draftFocused = false;
			// Click away from an empty draft dismisses it (Notion behavior).
			this.draftOutside = (e: MouseEvent) => {
				if (!this.draftEl || this.draftEl.contains(e.target as Node)) return;
				const ta = this.draftEl.querySelector("textarea");
				if (ta instanceof HTMLTextAreaElement && ta.value.trim() === "") {
					this.view.dispatch({ effects: clearDraft.of(null) });
				}
			};
			this.view.dom.ownerDocument.addEventListener("mousedown", this.draftOutside, true);
		} else if (!draft && this.draftEl) {
			this.draftEl.remove();
			this.draftEl = null;
			this.removeDraftOutside();
		}
		if (draft && this.draftEl && !this.draftFocused) {
			this.draftFocused = true;
			window.setTimeout(() => this.draftEl?.querySelector("textarea")?.focus(), 0);
		}
	}

	private removeDraftOutside(): void {
		if (this.draftOutside) {
			this.view.dom.ownerDocument.removeEventListener("mousedown", this.draftOutside, true);
			this.draftOutside = null;
		}
	}

	private buildDraftEl(): HTMLElement {
		// Editor path: offsets come live from draftField (mapped through every edit),
		// so no stale-offset verification is needed here.
		const { el } = buildDraftComposer({
			onCancel: () => this.view.dispatch({ effects: clearDraft.of(null) }),
			onSubmit: (text) => {
				const draft = this.view.state.field(draftField, false);
				if (text && draft) notifyErr(addComment(this.view, draft.from, draft.to, text, this.cb.getAuthor()));
				this.view.dispatch({ effects: clearDraft.of(null) });
			},
		});
		return el;
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
		const spans = this.view.contentDOM.querySelectorAll(spanSelector(id));
		spans.forEach((s) => s.classList.toggle("is-active", active));
	}

	/** Clicking a margin card flashes its highlighted text. No document scroll: the
	 *  card is already aligned to its text, so scrolling the doc was pure disruption. */
	private flashAnchor(id: string): void {
		this.setActive(id);
		const span = this.view.contentDOM.querySelector(spanSelector(id));
		if (!span) return;
		span.classList.add("dc-flash");
		window.setTimeout(() => span.classList.remove("dc-flash"), FLASH_MS);
	}

	/** Scroll the editor the minimum needed to bring a just-opened reply composer
	 *  fully into view — without the jump-to-anchor that felt jarring. */
	private revealComposer(id: string): void {
		const card = this.cards.get(id);
		if (!card) return;
		this.view.requestMeasure({
			read: () => {
				const box = card.el.querySelector(".dc-field--composer");
				if (!(box instanceof HTMLElement)) return 0;
				const c = box.getBoundingClientRect();
				const s = this.view.scrollDOM.getBoundingClientRect();
				if (c.bottom > s.bottom) return c.bottom - s.bottom + 12;
				if (c.top < s.top) return c.top - s.top - 12;
				return 0;
			},
			write: (delta) => {
				if (delta) this.view.scrollDOM.scrollTop += delta;
			},
		});
	}

	private onContentMouseDown = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	private onContentMouseOver = (e: MouseEvent): void => {
		const id = closestSpanId(e.target);
		if (id) this.setActive(id);
	};

	private onContentMouseOut = (e: MouseEvent): void => {
		const span = e.target instanceof Element ? e.target.closest(".doc-comment-span") : null;
		if (!span) return;
		// Ignore moves that stay within the same highlight element (avoids flicker).
		const to = e.relatedTarget;
		if (to instanceof Node && span.contains(to)) return;
		this.setActive(null);
	};
}

export const marginPlugin = ViewPlugin.fromClass(MarginView);
