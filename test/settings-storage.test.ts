import { describe, expect, test, vi } from "vitest";
import { loadSettingsData, saveSettingsData } from "../src/settings-storage";

describe("settings storage", () => {
	test("turns a rejected plugin load into an explicit Result", async () => {
		const loadData = vi.fn(async () => {
			throw new Error("vault unavailable");
		});

		const loaded = await loadSettingsData(loadData);

		expect(loaded.isErr()).toBe(true);
		if (loaded.isErr()) {
			expect(loaded.error).toEqual({ type: "settings_load_failed", message: "vault unavailable" });
		}
	});

	test("turns a rejected plugin save into an explicit Result", async () => {
		const saveData = vi.fn(async () => {
			throw new Error("disk full");
		});

		const saved = await saveSettingsData(saveData, { author: "Alice" });

		expect(saved.isErr()).toBe(true);
		if (saved.isErr()) {
			expect(saved.error).toEqual({ type: "settings_save_failed", message: "disk full" });
		}
	});

	test("passes loaded and saved plugin data through successful Results", async () => {
		const data = { author: "Alice" };
		const loadData = vi.fn(async () => data);
		const saveData = vi.fn(async () => {});

		const loaded = await loadSettingsData(loadData);
		const saved = await saveSettingsData(saveData, data);

		expect(loaded.isOk() && loaded.value).toBe(data);
		expect(saved.isOk()).toBe(true);
		expect(saveData).toHaveBeenCalledWith(data);
	});
});
