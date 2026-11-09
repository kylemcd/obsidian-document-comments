// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TFile, WorkspaceLeaf } from "obsidian";
import DocCommentsPlugin from "../src/main";
import { commentConfig } from "../src/editor/config";
import { marginPlugin } from "../src/editor/margin";
import { CommentsSidebarView, type SidebarDeps } from "../src/ui/sidebar";
import { installObsidianDom } from "./obsidian-dom";

vi.mock("../src/ui/card", () => ({
	Card: class {
		el = document.createElement("div");
		signature = "";
		update(): void {}
		refreshAuthorColors(): void {}
		destroy(): void {}
	},
}));

beforeAll(() => {
	installObsidianDom();
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

const body = (id: string, status: string): string =>
	`<!--co:${id} by:me at:2026-06-17T00:00:00.000Z status:${status} quote:"x"\nme: a thought\n-->`;

const DOC = [
	"Ship on <!--c:aaa-->Friday<!--/c:aaa--> now.",
	body("aaa", "open"),
	"",
	"Done <!--c:bbb-->already<!--/c:bbb--> then.",
	body("bbb", "resolved"),
].join("\n");

describe("clicking a highlight in Live Preview", () => {
	const clicked = (init: MouseEventInit): string[] => {
		const seen: string[] = [];
		const view = new EditorView({
			state: EditorState.create({
				doc: "Ship on Friday now.",
				extensions: [commentConfig.of({ onHighlightClick: (id) => seen.push(id) } as never), marginPlugin],
			}),
		});
		const highlight = view.contentDOM.createSpan({ cls: "doc-comment-span", attr: { "data-cid": "aaa" } });
		highlight.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...init }));
		view.destroy();
		return seen;
	};

	test("reports the comment", () => {
		expect(clicked({ button: 0 })).toEqual(["aaa"]);
	});

	test("ignores a right-click, which opens a menu", () => {
		expect(clicked({ button: 2 })).toEqual([]);
	});
});

describe("the sidebar bringing up a clicked comment", () => {
	const openSidebar = async (): Promise<CommentsSidebarView> => {
		const file = new TFile("note.md");
		const view = new CommentsSidebarView(new WorkspaceLeaf(), {} as SidebarDeps);
		Object.defineProperty(view, "app", {
			value: {
				workspace: {
					getActiveViewOfType: () => ({ file }),
					getLeavesOfType: () => [],
					getActiveFile: () => file,
					on: () => ({}),
				},
				vault: { on: () => ({}), read: async () => DOC },
			},
		});
		await view.onOpen();
		return view;
	};

	const activeTab = (view: CommentsSidebarView): string | null =>
		view.contentEl.querySelector(".dc-sidebar__tab.is-active span")?.textContent ?? null;

	const flashing = (view: CommentsSidebarView): number => view.contentEl.querySelectorAll(".dc-flash").length;

	test("stays on the filter that already shows the thread", async () => {
		const view = await openSidebar();

		await view.revealComment("aaa");

		expect(activeTab(view)).toBe("Open");
		expect(flashing(view)).toBe(1);
	});

	test("shows every thread when the filter hides this one", async () => {
		const view = await openSidebar();

		await view.revealComment("bbb");

		expect(activeTab(view)).toBe("All");
		expect(flashing(view)).toBe(1);
	});

	// An embed shows another note's highlights, and an empty highlight has no card.
	test("changes nothing for a comment it has no card for", async () => {
		const view = await openSidebar();

		await view.revealComment("elsewhere");

		expect(activeTab(view)).toBe("Open");
		expect(flashing(view)).toBe(0);
	});
});

describe("the plugin on a highlight click", () => {
	const plugin = (sidebarOpen: boolean): { reveal: ReturnType<typeof vi.fn>; instance: DocCommentsPlugin } => {
		const Plugin = DocCommentsPlugin as unknown as new () => DocCommentsPlugin;
		const reveal = vi.fn(async () => undefined);
		const view = Object.assign(Object.create(CommentsSidebarView.prototype), { revealComment: reveal });
		const instance = new Plugin();
		Object.assign(instance, { sidebarOpen });
		Object.defineProperty(instance, "app", { value: { workspace: { getLeavesOfType: () => [{ view }] } } });
		return { reveal, instance };
	};

	test("brings up the thread in an open sidebar", async () => {
		const { reveal, instance } = plugin(true);

		instance.revealClickedComment("aaa");

		await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("aaa"));
	});

	test("leaves a closed sidebar closed", async () => {
		const { reveal, instance } = plugin(false);

		instance.revealClickedComment("aaa");
		await new Promise((resolve) => window.setTimeout(resolve, 40));

		expect(reveal).not.toHaveBeenCalled();
	});
});
