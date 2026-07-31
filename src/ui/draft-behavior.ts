import type { Result } from "better-result";

export type EmptySubmitAction = "none" | "highlight" | "remove";
export type DraftSubmitHandler = (text: string) => Result<void, string> | Promise<Result<void, string>>;

export const emptySubmitLabel = (action: EmptySubmitAction): string => {
	return action === "highlight" ? "Empty comment" : action === "remove" ? "Remove highlight" : "Comment";
};

export const draftPlaceholder = (action: EmptySubmitAction): string => {
	if (action === "highlight") return "Write a comment, or leave empty…";
	if (action === "remove") return "Write a comment, or leave empty to remove the highlight…";
	return "Write a comment…";
};

/** Submit every inline draft, including a blank one, and return the save result. */
export const submitDraft = (
	value: string,
	onSubmit: DraftSubmitHandler,
): Result<void, string> | Promise<Result<void, string>> => {
	return onSubmit(value.trim());
};
