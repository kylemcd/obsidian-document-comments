// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import DocCommentsPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";

const createPlugin = (): DocCommentsPlugin => {
	const PluginConstructor = DocCommentsPlugin as unknown as new () => DocCommentsPlugin;
	return new PluginConstructor();
};

describe("plugin settings persistence", () => {
	test("persists an initial generated assignment and restores it on reload", async () => {
		const first = createPlugin();
		let saved: unknown = null;
		vi.spyOn(first, "loadData").mockResolvedValue({
			author: "Alice",
			authorColorsEnabled: true,
			authorColors: {},
			excludedAuthorColors: [],
		});
		vi.spyOn(first, "saveData").mockImplementation(async (data) => {
			saved = structuredClone(data);
		});

		await first.loadSettings();
		const assignment = first.settings.authorColors.Alice;

		expect(assignment).toBeDefined();
		expect(saved).not.toBeNull();

		const reloaded = createPlugin();
		vi.spyOn(reloaded, "loadData").mockResolvedValue(saved);
		const reloadSave = vi.spyOn(reloaded, "saveData").mockResolvedValue();
		await reloaded.loadSettings();

		expect(reloaded.settings.authorColors.Alice).toEqual(assignment);
		expect(reloadSave).not.toHaveBeenCalled();
	});

	test("falls back without overwriting data when plugin settings fail to load", async () => {
		const plugin = createPlugin();
		vi.spyOn(plugin, "loadData").mockRejectedValue(new Error("vault unavailable"));
		const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue();

		await expect(plugin.loadSettings()).resolves.toBeUndefined();

		expect(plugin.settings.authorColorsEnabled).toBe(DEFAULT_SETTINGS.authorColorsEnabled);
		expect(plugin.settingsError()).toBe("Couldn't load settings: vault unavailable");
		expect(saveData).not.toHaveBeenCalled();
	});

	test("rolls back picker, delete, and restore mutations after rejected writes", async () => {
		const plugin = createPlugin();
		plugin.settings = {
			...DEFAULT_SETTINGS,
			authorColorsEnabled: true,
			authorColors: { Alice: { color: "#0090ff", mode: "generated" } },
			excludedAuthorColors: [],
		};
		vi.spyOn(plugin, "saveData").mockRejectedValue(new Error("disk full"));
		vi.spyOn(plugin, "refreshEditors").mockImplementation(() => {});

		await plugin.setAuthorColor("Alice", "#abcdef");
		expect(plugin.settings.authorColors.Alice).toEqual({ color: "#0090ff", mode: "generated" });

		await plugin.deleteAuthorColor("Alice");
		expect(plugin.settings.authorColors.Alice).toEqual({ color: "#0090ff", mode: "generated" });
		expect(plugin.settings.excludedAuthorColors).toEqual([]);

		const restorePlugin = createPlugin();
		vi.spyOn(restorePlugin, "loadData").mockResolvedValue({
			...DEFAULT_SETTINGS,
			author: "Bob",
			authorColorsEnabled: true,
			authorColors: { Bob: { color: "#e54d2e", mode: "generated" } },
			excludedAuthorColors: ["Alice"],
		});
		await restorePlugin.loadSettings();
		vi.spyOn(restorePlugin, "saveData").mockRejectedValue(new Error("disk full"));
		vi.spyOn(restorePlugin, "refreshEditors").mockImplementation(() => {});

		await restorePlugin.restoreAuthorColor("Alice");
		expect(restorePlugin.settings.authorColors.Alice).toBeUndefined();
		expect(restorePlugin.settings.excludedAuthorColors).toEqual(["Alice"]);
		expect(restorePlugin.settingsError()).toBe("Couldn't persist highlight colors: disk full");
	});
});
