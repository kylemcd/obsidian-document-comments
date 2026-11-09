// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { ReadingMarginManager, type ReadingDeps } from "../src/reading/margin";
import { installObsidianDom } from "./obsidian-dom";

beforeAll(installObsidianDom);

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

	// The stylesheet keys the centered layout on `.dc-has.dc-centered`, so the class
	// follows the column and the setting, and goes away with the margin.
	test("adds dc-centered beside dc-has only when the text should stay centered", async () => {
		const doc = [
			"Ship on <!--c:aaa-->Friday<!--/c:aaa--> regardless.",
			'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
			"me: sounds good",
			"-->",
		].join("\n");
		const classesWith = async (centerText: boolean): Promise<{ shown: string[]; afterDestroy: string[] }> => {
			const wrapper = document.createElement("div");
			const readingView = wrapper.createDiv("markdown-reading-view");
			readingView.createDiv("markdown-preview-view");
			const view = new MarkdownView();
			Object.defineProperty(view, "containerEl", { value: wrapper });
			view.file = { path: "note.md" };
			const deps = {
				app: { workspace: { getLeavesOfType: () => [{ view }] }, vault: { read: async () => doc } },
				getAuthor: () => "Bob",
				colorForAuthor: () => null,
				highlightColorForAuthor: () => null,
				showComments: () => true,
				showResolved: () => true,
				showHighlights: () => true,
				centerText: () => centerText,
				allowEmptyComments: () => false,
				sidebarOpen: () => false,
				isMobile: () => false,
			} as unknown as ReadingDeps;
			const manager = new ReadingMarginManager(deps);

			manager.refresh();
			await vi.waitFor(() => expect(readingView.classList.contains("dc-has")).toBe(true));
			const shown = [...readingView.classList];
			manager.destroy();
			return { shown, afterDestroy: [...readingView.classList] };
		};

		const centered = await classesWith(true);
		expect(centered.shown).toContain("dc-centered");
		expect(centered.afterDestroy).not.toContain("dc-centered");
		expect((await classesWith(false)).shown).not.toContain("dc-centered");
	});
});

describe("clicking a highlight in Reading view", () => {
	const clicked = (init: MouseEventInit, target: "highlight" | "text" = "highlight"): string[] => {
		const wrapper = document.createElement("div");
		const readingView = wrapper.createDiv("markdown-reading-view");
		const preview = readingView.createDiv("markdown-preview-view");
		preview.innerHTML = '<p>Ship on <span class="doc-comment-span" data-cid="aaa">Friday</span> now.</p>';
		const view = new MarkdownView();
		Object.defineProperty(view, "containerEl", { value: wrapper });
		view.file = { path: "note.md" };
		const seen: string[] = [];
		const deps = {
			app: { workspace: { getLeavesOfType: () => [{ view }] }, vault: { read: async () => "" } },
			getAuthor: () => "Bob",
			colorForAuthor: () => null,
			highlightColorForAuthor: () => null,
			showComments: () => true,
			showResolved: () => true,
			showHighlights: () => true,
			centerText: () => false,
			allowEmptyComments: () => false,
			sidebarOpen: () => true,
			onHighlightClick: (id: string) => seen.push(id),
			isMobile: () => false,
		} as unknown as ReadingDeps;
		const manager = new ReadingMarginManager(deps);
		manager.refresh();
		const el = target === "highlight" ? preview.querySelector(".doc-comment-span")! : preview.querySelector("p")!;
		el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...init }));
		manager.destroy();
		return seen;
	};

	test("reports the comment", () => {
		expect(clicked({ button: 0 })).toEqual(["aaa"]);
	});

	test("ignores a right-click, which opens a menu", () => {
		expect(clicked({ button: 2 })).toEqual([]);
	});

	test("ignores a click on text with no comment", () => {
		expect(clicked({ button: 0 }, "text")).toEqual([]);
	});
});
