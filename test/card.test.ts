// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { Result } from "better-result";
import { ParsedComment } from "../src/format/types";
import { Card, CardCallbacks } from "../src/ui/card";

type ElementOptions = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> };

const applyOptions = (el: HTMLElement, options?: ElementOptions): void => {
	if (typeof options === "string") el.className = options;
	else if (options) {
		if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
		if (options.text !== undefined) el.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
	}
};

beforeAll(() => {
	(globalThis as unknown as { createDiv: (options?: ElementOptions) => HTMLDivElement }).createDiv = (options) => {
		const el = document.createElement("div");
		applyOptions(el, options);
		return el;
	};
	HTMLElement.prototype.createDiv = function (options?: ElementOptions) {
		const el = this.ownerDocument.createElement("div");
		applyOptions(el, options);
		this.appendChild(el);
		return el;
	};
	HTMLElement.prototype.createSpan = function (options?: ElementOptions) {
		const el = this.ownerDocument.createElement("span");
		applyOptions(el, options);
		this.appendChild(el);
		return el;
	};
	HTMLElement.prototype.createEl = function (tag: string, options?: ElementOptions) {
		const el = this.ownerDocument.createElement(tag);
		applyOptions(el, options);
		this.appendChild(el);
		return el;
	};
	HTMLElement.prototype.empty = function () {
		this.replaceChildren();
	};
	HTMLElement.prototype.setText = function (text: string) {
		this.textContent = text;
	};
	HTMLElement.prototype.toggleClass = function (cls: string, value: boolean) {
		this.classList.toggle(cls, value);
	};
	HTMLElement.prototype.setCssStyles = function (styles: Partial<CSSStyleDeclaration>) {
		Object.assign(this.style, styles);
	};
});

const emptyComment = (): ParsedComment => ({
	id: "h1",
	open: { from: 0, to: 13 },
	close: { from: 19, to: 33 },
	body: { from: 34, to: 100 },
	author: "kyle",
	createdAt: "2026-07-31T12:00:00.000Z",
	status: "open",
	quote: "Friday",
	thread: [],
	reactions: [],
});

const commentWithText = (): ParsedComment => ({
	...emptyComment(),
	thread: [{ author: "kyle", timestamp: "2026-07-31T12:00:00.000Z", text: "Existing comment" }],
});

const callbacks = (): CardCallbacks => ({
	getAuthor: () => "kyle",
	onHover: vi.fn(),
	onClickAnchor: vi.fn(),
	onResize: vi.fn(),
	reply: vi.fn(() => Result.ok(undefined)),
	setResolved: vi.fn(),
	remove: vi.fn(),
	editEntry: vi.fn(),
	deleteEntry: vi.fn(),
	toggleReaction: vi.fn(),
});

describe("broken table anchor notice", () => {
	const view = { sourcePath: () => "note.md", colorForAuthor: () => null };

	test("shows the notice and repair action only while the anchor is breaking a table", () => {
		const repairTableAnchor = vi.fn();
		const card = new Card(commentWithText(), { ...callbacks(), repairTableAnchor }, view);

		expect(card.el.querySelector(".dc-repair")).toBeNull();

		card.setTableAnchorBroken(true);
		expect(card.el.querySelector(".dc-repair__text")?.textContent).toBe("This comment is breaking its table.");
		card.el.querySelector<HTMLElement>(".dc-repair__action")?.click();
		expect(repairTableAnchor).toHaveBeenCalledWith(commentWithText().id);

		card.setTableAnchorBroken(false);
		expect(card.el.querySelector(".dc-repair")).toBeNull();
	});

	test("stays silent when no repair action is available, as in the sidebar", () => {
		const card = new Card(commentWithText(), callbacks(), view);

		card.setTableAnchorBroken(true);

		expect(card.el.querySelector(".dc-repair")).toBeNull();
	});

	test("never asks the margin to reposition", () => {
		// The margin reconciles inside CodeMirror's update cycle, and repositioning
		// reads layout — which throws there, taking the whole margin plugin down with
		// it. The scheduled measure pass after each reconcile picks the height change
		// up instead.
		const cb = { ...callbacks(), repairTableAnchor: vi.fn() };
		const card = new Card(commentWithText(), cb, view);
		(cb.onResize as ReturnType<typeof vi.fn>).mockClear();

		card.setTableAnchorBroken(true);
		card.setTableAnchorBroken(false);

		expect(cb.onResize).not.toHaveBeenCalled();
	});
});

/** A real click: press on `target`, release on `releaseOn`, then the click event,
 *  which a browser sends to the nearest element holding both ends. */
const click = (target: Element | null | undefined, releaseOn: Element | null | undefined = target): void => {
	if (!target || !releaseOn) throw new Error("nothing to click");
	target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	releaseOn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	let both: Element | null = target;
	while (both && !both.contains(releaseOn)) both = both.parentElement;
	both?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

/** Select the first `length` characters of `el`'s text. */
const selectText = (el: Element | null | undefined, length: number): void => {
	const node = el?.firstChild;
	if (!node) throw new Error("nothing to select");
	const range = document.createRange();
	range.setStart(node, 0);
	range.setEnd(node, length);
	document.getSelection()?.addRange(range);
};

describe("selecting comment text", () => {
	const view = { sourcePath: () => "note.md" };

	const mount = (cb: CardCallbacks, comment = commentWithText()): Card => {
		const card = new Card(comment, cb, view);
		document.body.appendChild(card.el);
		return card;
	};

	const unmount = (...cards: Card[]): void => {
		document.getSelection()?.removeAllRanges();
		for (const card of cards) {
			card.destroy();
			card.el.remove();
		}
	};

	const commentText = (card: Card): HTMLElement | null => card.el.querySelector<HTMLElement>(".dc-entry__text");
	const isOpen = (card: Card): boolean => card.el.classList.contains("is-open");

	test("pressing a closed card leaves it alone, so a drag can select its text", () => {
		// Opening on press rebuilt the card under the pointer and focused its reply
		// field, which threw the selection away before it could start (issue #80).
		const cb = callbacks();
		const card = mount(cb);
		const text = commentText(card);

		text?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

		expect(isOpen(card)).toBe(false);
		expect(commentText(card)).toBe(text);
		expect(cb.onClickAnchor).not.toHaveBeenCalled();
		unmount(card);
	});

	test("a click still opens the card and flashes its text", () => {
		const cb = callbacks();
		const card = mount(cb);

		click(commentText(card));

		expect(isOpen(card)).toBe(true);
		expect(cb.onClickAnchor).toHaveBeenCalledWith("h1");
		unmount(card);
	});

	test("a press that selects the comment's text keeps the selection", () => {
		const cb = callbacks();
		const card = mount(cb);
		const text = commentText(card);

		text?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		selectText(text, "Existing".length);
		text?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		text?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(document.getSelection()?.toString()).toBe("Existing");
		expect(isOpen(card)).toBe(false);
		expect(commentText(card)).toBe(text);
		expect(cb.onClickAnchor).not.toHaveBeenCalled();
		unmount(card);
	});

	test("text selected earlier doesn't stop a later click opening the card", () => {
		// Pressing a part of the card that can't be selected, like the author's name,
		// leaves an earlier selection where it was.
		const card = mount(callbacks());
		selectText(commentText(card), "Existing".length);

		click(card.el.querySelector(".dc-entry__author"));

		expect(isOpen(card)).toBe(true);
		unmount(card);
	});

	test("a selection somewhere else doesn't stop a click opening the card", () => {
		const card = mount(callbacks());
		const elsewhere = document.body.appendChild(document.createElement("p"));
		elsewhere.textContent = "Some note text";
		selectText(elsewhere, 4);

		click(commentText(card));

		expect(isOpen(card)).toBe(true);
		elsewhere.remove();
		unmount(card);
	});

	test("opens even when closing another card moves it out from under the pointer", () => {
		// Pressing a card closes the open one above it straight away, and the cards
		// below restack before the button comes up, so the release (and the click)
		// lands on the column instead of the pressed card.
		const column = document.body.appendChild(document.createElement("div"));
		const above = new Card(commentWithText(), callbacks(), view);
		const below = new Card({ ...commentWithText(), id: "h2" }, callbacks(), view);
		column.append(above.el, below.el);
		click(commentText(above));

		click(commentText(below), column);

		expect(isOpen(above)).toBe(false);
		expect(isOpen(below)).toBe(true);
		unmount(above, below);
		column.remove();
	});

	test("pressing a button and sliding off it doesn't open the card", () => {
		const cb = callbacks();
		const card = mount(cb, {
			...commentWithText(),
			reactions: [{ emoji: "👍", authors: ["sam"], entry: 0 }],
		});

		click(card.el.querySelector(".dc-reaction"), card.el.querySelector(".dc-entry__reactions"));

		expect(isOpen(card)).toBe(false);
		expect(cb.toggleReaction).not.toHaveBeenCalled();
		unmount(card);
	});

	test("a press whose release never comes doesn't open the card on a later release", () => {
		// Dragging selected text away is a drag-and-drop, which ends without a
		// mouseup; nor does a new press belong to the old one.
		const card = mount(callbacks());
		const elsewhere = document.body.appendChild(document.createElement("p"));

		commentText(card)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		commentText(card)?.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
		click(elsewhere);
		commentText(card)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		click(elsewhere);

		expect(isOpen(card)).toBe(false);
		elsewhere.remove();
		unmount(card);
	});

	test("a card removed mid-press stays closed", () => {
		const card = mount(callbacks());

		commentText(card)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		card.destroy();
		document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

		expect(isOpen(card)).toBe(false);
		card.el.remove();
	});

	test("comment text is selectable only once a press starts in its card", () => {
		// Selectable all the time, a drag through the note in Reading view that
		// overshoots onto a card would run on through every paragraph after it.
		const card = mount(callbacks());
		const elsewhere = document.body.appendChild(document.createElement("p"));

		expect(card.el.classList.contains("dc-selectable")).toBe(false);
		commentText(card)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(card.el.classList.contains("dc-selectable")).toBe(true);
		card.el.querySelector(".dc-entry__author")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(card.el.classList.contains("dc-selectable")).toBe(true);
		elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(card.el.classList.contains("dc-selectable")).toBe(false);
		elsewhere.remove();
		unmount(card);
	});

	test("pressing the Empty placeholder opens its editor and flashes the text", () => {
		const cb = callbacks();
		const card = mount(cb, emptyComment());

		click(card.el.querySelector(".dc-entry__text--empty"));

		expect(card.el.querySelector(".dc-field--edit textarea")).not.toBeNull();
		expect(cb.onClickAnchor).toHaveBeenCalledWith("h1");
		unmount(card);
	});
});

describe("empty comment card", () => {
	test("colors every displayed author name with that author's assignment", () => {
		const comment = {
			...commentWithText(),
			thread: [
				{ author: "kyle", text: "Original" },
				{ author: "Cathy", text: "Reply" },
			],
		};
		let changed: "custom" | "deleted" | "initial" = "initial";
		const card = new Card(comment, callbacks(), {
			sourcePath: () => "note.md",
			colorForAuthor: (author) => {
				if (author === "kyle") return "#0090ff";
				if (changed === "deleted") return null;
				return changed === "custom" ? "#6e56cf" : "#e54d2e";
			},
		});
		const authors = [...card.el.querySelectorAll<HTMLElement>(".dc-entry__author")];

		expect(authors.map((author) => author.dataset.dcAuthor)).toEqual(["kyle", "Cathy"]);
		expect(authors.map((author) => author.style.getPropertyValue("--dc-author-color"))).toEqual([
			"#0090ff",
			"#e54d2e",
		]);
		changed = "custom";
		card.refreshAuthorColors();
		expect(authors[1]?.style.getPropertyValue("--dc-author-color")).toBe("#6e56cf");
		changed = "deleted";
		card.refreshAuthorColors();
		expect(authors[1]?.style.getPropertyValue("--dc-author-color")).toBe("");
		card.destroy();
	});

	test("shows an Empty placeholder and saves its first text as a reply", () => {
		const cb = callbacks();
		const card = new Card(emptyComment(), cb, { sourcePath: () => "note.md" });
		const placeholder = card.el.querySelector<HTMLElement>(".dc-entry__text--empty");

		expect(placeholder?.textContent).toBe("Empty");
		expect(card.el.querySelector(".dc-entry__author")?.textContent).toBe("kyle");
		placeholder?.click();

		const editor = card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea");
		expect(editor).not.toBeNull();
		if (editor) editor.value = "Add the first comment";
		card.el.querySelector<HTMLButtonElement>("button[aria-label='Save']")?.click();

		expect(cb.reply).toHaveBeenCalledWith("h1", "Add the first comment");
		expect(cb.editEntry).not.toHaveBeenCalled();
		card.destroy();
	});

	test("opens and focuses the editor when the empty card is clicked", async () => {
		const card = new Card(emptyComment(), callbacks(), { sourcePath: () => "note.md" });
		document.body.appendChild(card.el);
		click(card.el);

		const editor = card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea");
		expect(editor).not.toBeNull();
		expect(card.el.querySelector(".dc-field--composer")).toBeNull();
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		expect(document.activeElement).toBe(editor);
		card.destroy();
		card.el.remove();
	});

	test("hides the comment composer while the Empty placeholder is edited", () => {
		const card = new Card(emptyComment(), callbacks(), { sourcePath: () => "note.md" });
		document.body.appendChild(card.el);
		click(card.el);
		card.el.querySelector<HTMLButtonElement>(".dc-entry__text--empty")?.click();

		expect(card.el.querySelector(".dc-field--edit textarea")).not.toBeNull();
		expect(card.el.querySelector(".dc-field--composer")).toBeNull();
		card.destroy();
		card.el.remove();
	});

	test("keeps the first comment draft when saving fails", async () => {
		const cb = callbacks();
		cb.reply = vi.fn(async () => Result.err("write failed"));
		const card = new Card(emptyComment(), cb, { sourcePath: () => "note.md" });
		card.el.querySelector<HTMLElement>(".dc-entry__text--empty")?.click();

		const editor = card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea");
		expect(editor).not.toBeNull();
		if (editor) {
			editor.value = "Keep this draft";
			editor.dispatchEvent(new Event("input"));
		}
		card.el.querySelector<HTMLButtonElement>("button[aria-label='Save']")?.click();

		await vi.waitFor(() =>
			expect(card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea")?.disabled).toBe(false),
		);
		card.update(emptyComment());
		expect(card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea")?.value).toBe("Keep this draft");
		expect(cb.reply).toHaveBeenCalledWith("h1", "Keep this draft");
		card.destroy();
	});

	test("appends the draft when another first reply arrives during editing", () => {
		const cb = callbacks();
		const card = new Card(emptyComment(), cb, { sourcePath: () => "note.md" });
		card.el.querySelector<HTMLElement>(".dc-entry__text--empty")?.click();

		const editor = card.el.querySelector<HTMLTextAreaElement>(".dc-field--edit textarea");
		if (editor) {
			editor.value = "Local reply";
			editor.dispatchEvent(new Event("input"));
		}
		card.update(commentWithText());
		card.el.querySelector<HTMLButtonElement>("button[aria-label='Save']")?.click();

		expect(cb.reply).toHaveBeenCalledWith("h1", "Local reply");
		expect(cb.editEntry).not.toHaveBeenCalled();
		card.destroy();
	});

	test("targets the reply whose reaction button was used", () => {
		const cb = callbacks();
		const comment = {
			...commentWithText(),
			thread: [
				{ author: "kyle", text: "Original" },
				{ author: "Cathy", text: "Reply" },
			],
		};
		const card = new Card(comment, cb, { sourcePath: () => "note.md" });
		const reactButtons = card.el.querySelectorAll<HTMLButtonElement>('button[aria-label="React"]');

		reactButtons[1]?.click();
		document.body.querySelector<HTMLButtonElement>(".dc-pop__emoji")?.click();

		expect(cb.toggleReaction).toHaveBeenCalledWith({ id: "h1", entry: 1, emoji: "👍" });
		card.destroy();
	});

	test("renders and toggles an existing reaction on its reply", () => {
		const cb = callbacks();
		const comment = {
			...commentWithText(),
			thread: [
				{ author: "kyle", text: "Original" },
				{ author: "Cathy", text: "Reply" },
			],
			reactions: [{ emoji: "👀", authors: ["kyle"], entry: 1 }],
		};
		const card = new Card(comment, cb, { sourcePath: () => "note.md" });
		const entries = card.el.querySelectorAll<HTMLElement>(".dc-entry");

		expect(entries[0]?.querySelector(".dc-reaction")).toBeNull();
		expect(entries[1]?.querySelector(".dc-reaction__emoji")?.textContent).toBe("👀");
		entries[1]?.querySelector<HTMLButtonElement>(".dc-reaction")?.click();
		expect(cb.toggleReaction).toHaveBeenCalledWith({ id: "h1", entry: 1, emoji: "👀" });
		card.destroy();
	});

	test("keeps a reply draft when saving fails", async () => {
		const cb = callbacks();
		cb.reply = vi.fn(async () => Result.err("write failed"));
		const card = new Card(commentWithText(), cb, { sourcePath: () => "note.md" });
		document.body.appendChild(card.el);
		click(card.el);

		const composer = card.el.querySelector<HTMLTextAreaElement>(".dc-field--composer textarea");
		expect(composer).not.toBeNull();
		if (composer) {
			composer.value = "Keep this reply";
			composer.dispatchEvent(new Event("input"));
		}
		card.el.querySelector<HTMLButtonElement>("button[aria-label='Send']")?.click();

		await vi.waitFor(() =>
			expect(card.el.querySelector<HTMLTextAreaElement>(".dc-field--composer textarea")?.disabled).toBe(false),
		);
		card.update(commentWithText());
		expect(card.el.querySelector<HTMLTextAreaElement>(".dc-field--composer textarea")?.value).toBe(
			"Keep this reply",
		);
		expect(cb.reply).toHaveBeenCalledWith("h1", "Keep this reply");
		card.destroy();
		card.el.remove();
	});
});
