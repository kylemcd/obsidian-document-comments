import { describe, expect, test, vi } from "vitest";
import { draftPlaceholder, emptySubmitLabel, submitDraft } from "../src/ui/draft-behavior";

describe("draft behavior", () => {
	test("submits blank text so the caller can dismiss a disabled empty comment", () => {
		const onSubmit = vi.fn();

		submitDraft("   ", onSubmit);

		expect(onSubmit).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("");
	});

	test("describes highlight removal for an empty confirmation", () => {
		expect(draftPlaceholder("remove")).toContain("remove the highlight");
		expect(emptySubmitLabel("remove")).toBe("Remove highlight");
	});
});
