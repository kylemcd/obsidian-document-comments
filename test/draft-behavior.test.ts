import { describe, expect, test, vi } from "vitest";
import { Result } from "better-result";
import { draftPlaceholder, emptySubmitLabel, submitDraft } from "../src/ui/draft-behavior";

describe("draft behavior", () => {
	test("submits blank text so the caller can dismiss a disabled empty comment", () => {
		const onSubmit = vi.fn(() => Result.ok(undefined));

		const result = submitDraft("   ", onSubmit);

		expect(onSubmit).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("");
		expect(result).toEqual(Result.ok(undefined));
	});

	test("describes highlight removal for an empty confirmation", () => {
		expect(draftPlaceholder("remove")).toContain("remove the highlight");
		expect(emptySubmitLabel("remove")).toBe("Remove highlight");
	});

	test("labels a new blank submission as an empty comment", () => {
		expect(draftPlaceholder("highlight")).toBe("Write a comment, or leave empty…");
		expect(emptySubmitLabel("highlight")).toBe("Empty comment");
	});
});
