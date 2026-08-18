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
		card.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

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
		card.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		card.el.querySelector<HTMLButtonElement>(".dc-entry__text--empty")?.click();

		expect(card.el.querySelector(".dc-field--edit textarea")).not.toBeNull();
		expect(card.el.querySelector(".dc-field--composer")).toBeNull();
		card.destroy();
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

	test("keeps a reply draft when saving fails", async () => {
		const cb = callbacks();
		cb.reply = vi.fn(async () => Result.err("write failed"));
		const card = new Card(commentWithText(), cb, { sourcePath: () => "note.md" });
		card.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

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
	});
});
