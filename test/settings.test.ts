// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { App, Setting } from "obsidian";
import { Result, type Result as ResultType } from "better-result";
import { DEFAULT_SETTINGS, DocCommentsSettingTab, type DocCommentsSettings } from "../src/settings";
import type { AuthorIndexState } from "../src/author-index";

const settings = (): DocCommentsSettings => ({
	author: "Alice",
	showComments: true,
	showResolved: false,
	showHighlights: true,
	highlightsOpenSidebar: true,
	allowEmptyComments: false,
	authorColorsEnabled: true,
	authorColors: {
		Alice: { color: "#0090ff", mode: "generated" },
		Former: { color: "#e54d2e", mode: "custom" },
	},
	excludedAuthorColors: ["Bob"],
});

const plugin = (state: AuthorIndexState) => ({
	settings: settings(),
	authorColorView: () => ({ state, active: ["Alice"], missing: ["Former"], uncolored: ["Bob"], saveError: null }),
	setAuthorColor: vi.fn(async () => {}),
	deleteAuthorColor: vi.fn(async () => {}),
	restoreAuthorColor: vi.fn(async () => {}),
	removeAuthorColor: vi.fn(async () => {}),
	rescanAuthors: vi.fn(async () => {}),
	scanAuthorsIfEnabled: vi.fn(async () => {}),
	saveSettings: vi.fn(async (): Promise<ResultType<void, string>> => Result.ok(undefined)),
	settingsError: vi.fn((): string | null => null),
	refreshEditors: vi.fn(),
	updateRibbon: vi.fn(),
});

describe("highlight color settings", () => {
	test("defaults author colors to off for vaults without a saved preference", () => {
		expect(DEFAULT_SETTINGS.authorColorsEnabled).toBe(false);
	});

	test("hides the highlight color group in declarative and legacy settings while colors are off", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authorColorsEnabled = false;
		const tab = new DocCommentsSettingTab(new App(), fake as never);

		expect(
			tab.getSettingDefinitions().some((definition) => "type" in definition && definition.type === "group"),
		).toBe(false);
		tab.display();
		expect(tab.containerEl.textContent).not.toContain("Highlight colors");
		expect(tab.containerEl.querySelector('input[type="color"]')).toBeNull();

		fake.settings.authorColorsEnabled = true;
		expect(
			tab.getSettingDefinitions().some((definition) => "type" in definition && definition.type === "group"),
		).toBe(true);
		tab.display();
		expect(tab.containerEl.textContent).toContain("Highlight colors");
		expect(tab.containerEl.querySelector('input[type="color"]')).not.toBeNull();
	});

	test("declarative definitions render built-in color pickers and retain missing creators", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		const group = tab
			.getSettingDefinitions()
			.find((definition) => "type" in definition && definition.type === "group");
		expect(group && "items" in group ? group.items?.map((item) => ("name" in item ? item.name : "")) : []).toEqual([
			"Highlight color index",
			"Alice",
			"Not currently found",
			"Former",
			"Uncolored",
			"Bob",
		]);

		const alice =
			group && "items" in group ? group.items?.find((item) => "name" in item && item.name === "Alice") : null;
		const container = document.createElement("div");
		const setting = new Setting(container);
		if (alice && "render" in alice && alice.render) alice.render(setting, {} as never);

		expect(container.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#0090ff");
		expect(setting.settingEl.classList.contains("dc-author-color-setting")).toBe(true);
		expect(container.querySelector<HTMLButtonElement>('button[data-icon="rotate-ccw"]')).toBeNull();
		expect(container.querySelector<HTMLButtonElement>('button[data-icon="trash-2"]')).not.toBeNull();
	});

	test("legacy display uses the same picker rows and exposes partial scan state", () => {
		const fake = plugin({
			status: "partial",
			authors: ["Alice"],
			errors: [{ path: "locked.md", message: "locked" }],
		});
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		tab.display();

		expect(tab.containerEl.querySelectorAll('input[type="color"]')).toHaveLength(2);
		expect(tab.containerEl.textContent).toContain("1 file could not be read");
		expect(tab.containerEl.textContent).toContain("Not currently found");
		expect(tab.containerEl.textContent).toContain("Uncolored");
		expect(tab.containerEl.textContent).toContain("This creator is not currently found in the vault.");
		expect(tab.containerEl.textContent).not.toContain("Automatically assigned color");
		expect(tab.containerEl.textContent).not.toContain("Custom color");
	});

	test("picker, delete, and restore controls route through plugin persistence", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authorColors.Alice = { color: "#0090ff", mode: "custom" };
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		tab.display();
		const picker = [...tab.containerEl.querySelectorAll<HTMLInputElement>('input[type="color"]')].find(
			(input) => input.value === "#0090ff",
		);
		picker!.value = "#abcdef";
		picker!.dispatchEvent(new Event("change"));
		expect(tab.containerEl.querySelector<HTMLButtonElement>('button[data-icon="rotate-ccw"]')).toBeNull();
		const remove = tab.containerEl.querySelector<HTMLButtonElement>('button[data-icon="trash-2"]');
		remove?.click();
		const restore = [...tab.containerEl.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Assign color",
		);
		restore?.click();

		expect(fake.setAuthorColor).toHaveBeenCalledWith("Alice", "#abcdef");
		expect(fake.deleteAuthorColor).toHaveBeenCalledWith("Alice");
		expect(fake.restoreAuthorColor).toHaveBeenCalledWith("Bob");
	});

	test("uncolored author row exposes delete to remove the author from colors", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.excludedAuthorColors = ["Bob"];
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		tab.display();

		const uncoloredSection = [...tab.containerEl.querySelectorAll<HTMLElement>(".dc-author-color-setting")].find(
			(el) => el.textContent?.includes("Bob"),
		);
		const deleteButton = uncoloredSection?.querySelector<HTMLButtonElement>('button[data-icon="trash-2"]');
		expect(deleteButton).not.toBeNull();
		deleteButton?.click();

		expect(fake.removeAuthorColor).toHaveBeenCalledWith("Bob");
	});

	test("global author color toggle persists without changing saved assignments", async () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		const before = structuredClone(fake.settings.authorColors);
		const tab = new DocCommentsSettingTab(new App(), fake as never);

		await tab.setControlValue("authorColorsEnabled", false);

		expect(fake.settings.authorColorsEnabled).toBe(false);
		expect(fake.settings.authorColors).toEqual(before);
		expect(fake.saveSettings).toHaveBeenCalledOnce();
		expect(fake.refreshEditors).toHaveBeenCalled();
	});

	test("enabling author colors does not auto-scan", async () => {
		const fake = plugin({ status: "idle", authors: [] });
		fake.settings.authorColorsEnabled = false;
		const before = structuredClone(fake.settings.authorColors);
		const tab = new DocCommentsSettingTab(new App(), fake as never);

		await tab.setControlValue("authorColorsEnabled", true);

		expect(fake.settings.authorColorsEnabled).toBe(true);
		expect(fake.settings.authorColors).toEqual(before);
		expect(fake.saveSettings).toHaveBeenCalledOnce();
		expect(fake.scanAuthorsIfEnabled).not.toHaveBeenCalled();
	});

	test("rolls back a rejected setting write and surfaces the failure inline", async () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authorColorsEnabled = false;
		fake.saveSettings.mockResolvedValue(Result.err("disk full"));
		fake.settingsError.mockReturnValue("Couldn't save settings: disk full");
		const tab = new DocCommentsSettingTab(new App(), fake as never);

		await tab.setControlValue("authorColorsEnabled", true);
		tab.display();

		expect(fake.settings.authorColorsEnabled).toBe(false);
		expect(fake.refreshEditors).not.toHaveBeenCalled();
		expect(fake.scanAuthorsIfEnabled).not.toHaveBeenCalled();
		expect(tab.containerEl.textContent).toContain("Settings error");
		expect(tab.containerEl.textContent).toContain("Couldn't save settings: disk full");
	});

	test("declarative authors control uses the current saved list as its default", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authors = ["Alice", "Bob", "Carol"];
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		const definitions = tab.getSettingDefinitions();
		const authors = definitions.find((definition) => "control" in definition && definition.control?.key === "authors");
		expect(authors && "control" in authors && authors.control?.type === "text" ? authors.control.defaultValue : "").toBe("Alice, Bob, Carol");
	});

	test("declarative authors control falls back to empty when no authors are saved", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authors = [];
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		const definitions = tab.getSettingDefinitions();
		const authors = definitions.find((definition) => "control" in definition && definition.control?.key === "authors");
		expect(authors && "control" in authors && authors.control?.type === "text" ? authors.control.defaultValue : "unexpected").toBe("");
	});
	test("declarative authors control reads back as a comma-separated string", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.authors = ["Alice", "Bob", "Carol"];
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		expect(tab.getControlValue("authors")).toBe("Alice, Bob, Carol");
	});

	test("declarative author control reads back the current single author", () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		fake.settings.author = "Alice";
		const tab = new DocCommentsSettingTab(new App(), fake as never);
		expect(tab.getControlValue("author")).toBe("Alice");
	});

	test("changing author or authors does not auto-generate colors", async () => {
		const fake = plugin({ status: "ready", authors: ["Alice"] });
		const before = structuredClone(fake.settings.authorColors);
		const tab = new DocCommentsSettingTab(new App(), fake as never);

		await tab.setControlValue("author", "Alice");
		await tab.setControlValue("authors", "Alice, Bob");

		expect(fake.settings.author).toBe("Alice");
		expect(fake.settings.authors).toEqual(["Alice", "Bob"]);
		expect(fake.settings.authorColors).toEqual(before);
	});
});
