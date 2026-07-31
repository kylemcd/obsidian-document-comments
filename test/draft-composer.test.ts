// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { Result } from "better-result";
import { buildDraftComposer } from "../src/ui/draft-composer";

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
	HTMLElement.prototype.createEl = function (tag: string, options?: ElementOptions) {
		const el = this.ownerDocument.createElement(tag);
		applyOptions(el, options);
		this.appendChild(el);
		return el;
	};
});

describe("draft composer", () => {
	test("preserves and refocuses the draft when saving fails", async () => {
		const onSubmit = vi.fn(async () => Result.err("write failed"));
		const { el, textarea } = buildDraftComposer({ onSubmit, onCancel: vi.fn(), emptyAction: "highlight" });
		document.body.appendChild(el);
		textarea.value = "Keep this comment";
		textarea.dispatchEvent(new Event("input"));

		el.querySelector<HTMLButtonElement>("button[aria-label='Comment']")?.click();
		expect(textarea.disabled).toBe(true);
		await vi.waitFor(() => expect(textarea.disabled).toBe(false));

		expect(textarea.value).toBe("Keep this comment");
		expect(document.activeElement).toBe(textarea);
		expect(onSubmit).toHaveBeenCalledWith("Keep this comment");
		el.remove();
	});

	test("updates the empty action without replacing the typed draft", () => {
		const { el, textarea, setEmptyAction } = buildDraftComposer({
			onSubmit: () => Result.ok(undefined),
			onCancel: vi.fn(),
			emptyAction: "highlight",
		});
		const confirm = el.querySelector<HTMLButtonElement>(".dc-round--confirm");

		expect(textarea.getAttribute("placeholder")).toContain("leave empty");
		expect(confirm?.getAttribute("aria-label")).toBe("Empty comment");
		textarea.value = "Draft text";
		textarea.dispatchEvent(new Event("input"));
		setEmptyAction("remove");

		expect(textarea.value).toBe("Draft text");
		expect(textarea.getAttribute("placeholder")).toContain("remove the highlight");
		expect(confirm?.getAttribute("aria-label")).toBe("Comment");
		textarea.value = "";
		textarea.dispatchEvent(new Event("input"));
		expect(confirm?.getAttribute("aria-label")).toBe("Remove highlight");
	});
});
