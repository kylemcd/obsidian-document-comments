export type EmptySubmitAction = "none" | "highlight" | "remove";

export const emptySubmitLabel = (action: EmptySubmitAction): string => {
	return action === "highlight" ? "Highlight" : action === "remove" ? "Remove highlight" : "Comment";
};

export const draftPlaceholder = (action: EmptySubmitAction): string => {
	if (action === "highlight") return "Write a comment, or leave empty to highlight…";
	if (action === "remove") return "Write a comment, or leave empty to remove the highlight…";
	return "Write a comment…";
};

/** Submit every inline draft, including a blank one, so its caller can dismiss it. */
export const submitDraft = (value: string, onSubmit: (text: string) => void): void => {
	onSubmit(value.trim());
};
