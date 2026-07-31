// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { App } from "obsidian";
import { Result } from "better-result";
import { CommentModal } from "../src/ui/comment-modal";

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
	HTMLElement.prototype.createDiv = function (options?: ElementOptions) {
		const el = this.ownerDocument.createElement("div");
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
});

const buttonWithText = (root: HTMLElement, text: string): HTMLButtonElement | undefined => {
	return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === text);
};

describe("comment modal", () => {
	test("stays open with its text when saving fails", async () => {
		const onSubmit = vi.fn(async () => Result.err("write failed"));
		const modal = new CommentModal(new App(), "Selected text", onSubmit, "highlight");
		modal.open();
		const textarea = modal.contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
		textarea.value = "Keep this comment";
		textarea.dispatchEvent(new Event("input"));

		buttonWithText(modal.contentEl, "Comment")?.click();
		expect(textarea.disabled).toBe(true);
		await vi.waitFor(() => expect(textarea.disabled).toBe(false));

		expect(textarea.value).toBe("Keep this comment");
		expect(document.activeElement).toBe(textarea);
		expect(onSubmit).toHaveBeenCalledWith("Keep this comment");
		modal.close();
	});

	test("closes only after a successful save", async () => {
		const modal = new CommentModal(new App(), "Selected text", () => Result.ok(undefined));
		modal.open();
		const textarea = modal.contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
		textarea.value = "Saved comment";
		textarea.dispatchEvent(new Event("input"));

		buttonWithText(modal.contentEl, "Comment")?.click();
		await vi.waitFor(() => expect(modal.contentEl.childElementCount).toBe(0));
	});

	test("closes after a disabled blank submission writes nothing", async () => {
		const onSubmit = vi.fn(() => Result.ok(undefined));
		const modal = new CommentModal(new App(), "Selected text", onSubmit);
		modal.open();

		buttonWithText(modal.contentEl, "Comment")?.click();
		await vi.waitFor(() => expect(modal.contentEl.childElementCount).toBe(0));
		expect(onSubmit).toHaveBeenCalledWith("");
	});
});
