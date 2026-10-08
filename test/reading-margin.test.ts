// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { ReadingMarginManager, type ReadingDeps } from "../src/reading/margin";

type ElementOptions = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> };

const applyOptions = (element: HTMLElement, options?: ElementOptions): void => {
	if (typeof options === "string") element.className = options;
	else if (options) {
		if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
		if (options.text !== undefined) element.textContent = options.text;
		Object.entries(options.attr ?? {}).forEach(([name, value]) => element.setAttribute(name, value));
	}
};

beforeAll(() => {
	(globalThis as unknown as { createDiv: (options?: ElementOptions) => HTMLDivElement }).createDiv = (options) => {
		const element = document.createElement("div");
		applyOptions(element, options);
		return element;
	};
	HTMLElement.prototype.createDiv = function (options?: ElementOptions) {
		const element = this.ownerDocument.createElement("div");
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.createEl = function (tag: string, options?: ElementOptions) {
		const element = this.ownerDocument.createElement(tag);
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.createSpan = function (options?: ElementOptions) {
		const element = this.ownerDocument.createElement("span");
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.detach = function () {
		this.remove();
	};
	HTMLElement.prototype.toggleClass = function (name: string, enabled: boolean) {
		this.classList.toggle(name, enabled);
	};
	HTMLElement.prototype.removeClasses = function (names: string[]) {
		this.classList.remove(...names);
	};
	HTMLElement.prototype.setCssStyles = function (styles: Partial<CSSStyleDeclaration>) {
		Object.assign(this.style, styles);
	};
});

describe("reading margin windows", () => {
	test("refreshes a reading container created in a pop-out window realm", () => {
		class ForeignHTMLElement {
			readonly nodeType = 1;
			readonly ownerDocument = { defaultView: { HTMLElement: ForeignHTMLElement } };
			readonly style = { setProperty: vi.fn() };
			readonly toggleClass = vi.fn();
			readonly removeClasses = vi.fn();
		}
		const readingView = new ForeignHTMLElement();
		const view = new MarkdownView();
		Object.defineProperty(view, "containerEl", {
			value: { querySelector: () => readingView },
		});
		const deps = {
			app: { workspace: { getLeavesOfType: () => [{ view }] } },
			getAuthor: () => "Bob",
			colorForAuthor: () => "#e54d2e",
			highlightColorForAuthor: () => "#e54d2e",
			showComments: () => true,
			showResolved: () => false,
			showHighlights: () => true,
			allowEmptyComments: () => false,
			sidebarOpen: () => false,
			isMobile: () => true,
		} as unknown as ReadingDeps;

		new ReadingMarginManager(deps).refresh();

		expect(readingView.toggleClass).toHaveBeenCalledWith("dc-highlights", true);
		expect(readingView.style.setProperty).toHaveBeenCalledWith("--dc-highlight-color", "#e54d2e");
		expect(readingView.style.setProperty).toHaveBeenCalledWith("--dc-draft-highlight-color", "#e54d2e");
	});

	// Mobile has no cards, so Toggle comments only ever showed there through the
	// highlights. It keeps hiding them now that highlights have their own setting.
	test("on mobile, hiding comments hides the highlights", () => {
		const readingView = document.createElement("div");
		readingView.className = "markdown-reading-view";
		const view = new MarkdownView();
		Object.defineProperty(view, "containerEl", { value: { querySelector: () => readingView } });
		const deps = {
			app: { workspace: { getLeavesOfType: () => [{ view }] } },
			getAuthor: () => "Bob",
			colorForAuthor: () => null,
			highlightColorForAuthor: () => null,
			showComments: () => false,
			showResolved: () => true,
			showHighlights: () => true,
			allowEmptyComments: () => false,
			sidebarOpen: () => false,
			isMobile: () => true,
		} as unknown as ReadingDeps;

		new ReadingMarginManager(deps).refresh();

		expect(readingView.classList.contains("dc-highlights")).toBe(false);
	});

	// A split editing pane on the same note is ahead of the file until it saves, and
	// the reading pane shows its text, so highlights sync against that text.
	test("syncs highlights with the text the pane shows, not the file", () => {
		const readingView = document.createElement("div");
		readingView.className = "markdown-reading-view";
		readingView.innerHTML =
			'<p><span class="doc-comment-span" data-cid="new1">Fresh</span> and ' +
			'<span class="doc-comment-span" data-cid="gone1">stale</span></p>';
		const view = new MarkdownView();
		Object.defineProperty(view, "containerEl", { value: { querySelector: () => readingView } });
		view.getViewData = () =>
			[
				"<!--c:new1-->Fresh<!--/c:new1--> and stale",
				'<!--co:new1 by:me status:open quote:"Fresh"',
				"me: hi",
				"-->",
			].join("\n");
		const deps = {
			app: { workspace: { getLeavesOfType: () => [{ view }] }, vault: { read: async () => "" } },
			getAuthor: () => "Bob",
			colorForAuthor: () => null,
			highlightColorForAuthor: () => null,
			showComments: () => true,
			showResolved: () => true,
			showHighlights: () => true,
			allowEmptyComments: () => false,
			sidebarOpen: () => false,
			isMobile: () => true,
		} as unknown as ReadingDeps;

		new ReadingMarginManager(deps).refresh();

		expect(readingView.querySelector("[data-cid='new1']")).not.toBeNull();
		expect(readingView.querySelector("[data-cid='gone1']")).toBeNull();
		expect(readingView.textContent).toBe("Fresh and stale");
	});

	test("keeps an open nested draft live when the current author's color changes", () => {
		let currentColor: "#e54d2e" | "#6e56cf" = "#e54d2e";
		let mobile = false;
		const wrapper = document.createElement("div");
		const readingView = wrapper.createDiv("markdown-reading-view");
		const scroller = readingView.createDiv("markdown-preview-view");
		const existing = scroller.createSpan("doc-comment-span");
		existing.style.setProperty("--dc-highlight-color", "#0090ff");
		existing.textContent = "Friday";
		const view = new MarkdownView();
		Object.defineProperty(view, "containerEl", { value: wrapper });
		const deps = {
			app: { workspace: { getLeavesOfType: () => [{ view }] } },
			getAuthor: () => "Bob",
			colorForAuthor: () => currentColor,
			highlightColorForAuthor: () => currentColor,
			showComments: () => true,
			showResolved: () => false,
			showHighlights: () => true,
			allowEmptyComments: () => false,
			sidebarOpen: () => false,
			isMobile: () => mobile,
		} as unknown as ReadingDeps;
		const manager = new ReadingMarginManager(deps);
		const range = document.createRange();
		range.selectNodeContents(existing);

		manager.startDraft(view, 0, 6, range, "Friday", "none");
		const draft = existing.querySelector<HTMLElement>(".dc-draft");
		expect(draft?.style.getPropertyValue("--dc-highlight-color")).toBe("");
		expect(readingView.style.getPropertyValue("--dc-draft-highlight-color")).toBe("#e54d2e");

		currentColor = "#6e56cf";
		mobile = true;
		manager.refresh();

		expect(readingView.style.getPropertyValue("--dc-draft-highlight-color")).toBe("#6e56cf");
		expect(draft?.style.getPropertyValue("--dc-highlight-color")).toBe("");
		manager.destroy();
	});
});
