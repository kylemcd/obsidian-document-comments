// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import { Platform, TFile } from "obsidian";
import DocCommentsPlugin from "../src/main";
import { DEFAULT_SETTINGS, type OpenSidebarMode } from "../src/settings";

const WITH_COMMENT = [
	"Ship on <!--c:aaa-->Friday<!--/c:aaa--> now.",
	'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
	"me: a thought",
	"-->",
].join("\n");
const MARKERS_ONLY = "Ship on <!--c:aaa-->Friday<!--/c:aaa--> now.";
const EMPTY_HIGHLIGHT = [
	"Ship on <!--c:aaa-->Friday<!--/c:aaa--> now.",
	'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
	"-->",
].join("\n");

beforeAll(() => {
	(globalThis as unknown as { activeWindow: Window }).activeWindow = window;
});

type Setup = {
	mode?: OpenSidebarMode;
	text?: string;
	read?: () => Promise<string>;
	visible?: boolean;
	active?: TFile | null;
};

const NOTE = new TFile("note.md");

const setup = ({ mode = "always", text = WITH_COMMENT, read, visible = false, active = NOTE }: Setup = {}) => {
	const Plugin = DocCommentsPlugin as unknown as new () => DocCommentsPlugin;
	const plugin = new Plugin();
	plugin.settings = { ...DEFAULT_SETTINGS, openSidebar: mode };
	const setViewState = vi.fn(async () => undefined);
	const leaf = { setViewState };
	const shown = { getRoot: () => ({}), view: { containerEl: { offsetParent: {} } } };
	Object.defineProperty(plugin, "app", {
		value: {
			workspace: {
				getActiveFile: () => active,
				getLeavesOfType: () => (visible ? [shown] : []),
				getRightLeaf: () => leaf,
				revealLeaf: vi.fn(async () => undefined),
				leftSplit: {},
				rightSplit: {},
			},
			vault: { cachedRead: read ?? (async () => text) },
		},
	});
	return { plugin, setViewState };
};

describe("opening the sidebar when a note opens", () => {
	test("does nothing with the setting off", async () => {
		const { plugin, setViewState } = setup({ mode: "never" });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("for every note, opens it even on a note with no comments", async () => {
		const { plugin, setViewState } = setup({ mode: "always", text: "No comments here." });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).toHaveBeenCalledOnce();
	});

	// The note was just opened to be read or typed in.
	test("leaves focus in the note", async () => {
		const { plugin, setViewState } = setup();

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
	});

	test("for notes with comments, opens it on a note with a comment", async () => {
		const { plugin, setViewState } = setup({ mode: "withComments" });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).toHaveBeenCalledOnce();
	});

	test("counts an empty highlight, which the sidebar lists", async () => {
		const { plugin, setViewState } = setup({ mode: "withComments", text: EMPTY_HIGHLIGHT });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).toHaveBeenCalledOnce();
	});

	test.each([
		["no comments", "No comments here."],
		["markers but no comment to list", MARKERS_ONLY],
	])("for notes with comments, leaves it closed on a note with %s", async (_label, text) => {
		const { plugin, setViewState } = setup({ mode: "withComments", text });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("leaves it closed when the note can't be read", async () => {
		const read = async (): Promise<string> => {
			throw new Error("gone");
		};
		const { plugin, setViewState } = setup({ mode: "withComments", read });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("ignores a file that isn't a note, and no file at all", async () => {
		const { plugin, setViewState } = setup();

		await plugin.openSidebarForNote(new TFile("photo.png", "png"));
		await plugin.openSidebarForNote(null);

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("leaves a sidebar that's already showing alone", async () => {
		const { plugin, setViewState } = setup({ visible: true });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("skips a note you've already left", async () => {
		const { plugin, setViewState } = setup({ mode: "withComments", active: new TFile("other.md") });

		await plugin.openSidebarForNote(NOTE);

		expect(setViewState).not.toHaveBeenCalled();
	});

	// On mobile the sidebar is a drawer that would cover the note just opened.
	test("does nothing on mobile", async () => {
		const { plugin, setViewState } = setup();
		Platform.isMobile = true;

		await plugin.openSidebarForNote(NOTE);
		Platform.isMobile = false;

		expect(setViewState).not.toHaveBeenCalled();
	});

	// The sidebar lives in the main window, so revealing it would pull focus away.
	test("does nothing for a note in a pop-out window", async () => {
		const { plugin, setViewState } = setup();
		const main = window;
		(globalThis as unknown as { activeWindow: unknown }).activeWindow = {};

		await plugin.openSidebarForNote(NOTE);
		(globalThis as unknown as { activeWindow: unknown }).activeWindow = main;

		expect(setViewState).not.toHaveBeenCalled();
	});

	test("opens one sidebar when two notes open at once", async () => {
		const { plugin, setViewState } = setup();

		await Promise.all([plugin.openSidebarForNote(NOTE), plugin.openSidebarForNote(NOTE)]);

		expect(setViewState).toHaveBeenCalledOnce();
	});
});
