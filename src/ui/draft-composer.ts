import { setIcon } from "obsidian";

export type DraftComposerHandlers = {
	/** Called with the trimmed text on Enter or the confirm button. */
	onSubmit: (text: string) => void;
	onCancel: () => void;
	/** Allow the confirm action to submit an empty comment as a highlight. */
	allowEmpty?: boolean;
};

/**
 * The inline "new comment" composer card (textarea + cancel/confirm), shared by
 * the editor and reading-view margins. Enter submits, Shift+Enter inserts a
 * newline, Escape cancels. The caller owns what submit/cancel actually do.
 */
export const buildDraftComposer = (
	handlers: DraftComposerHandlers,
): { el: HTMLElement; textarea: HTMLTextAreaElement } => {
	const el = createDiv("doc-comment-card is-draft");
	const box = el.createDiv("dc-field dc-field--composer");
	const textarea = box.createEl("textarea", {
		cls: "dc-field__input",
		attr: {
			placeholder: handlers.allowEmpty ? "Write a comment, or leave empty to highlight…" : "Write a comment…",
			rows: "2",
		},
	});
	const actions = box.createDiv("dc-field__actions");
	const submit = () => {
		const text = textarea.value.trim();
		if (text || handlers.allowEmpty) handlers.onSubmit(text);
	};

	const cancelBtn = actions.createEl("button", {
		cls: "dc-round dc-round--cancel",
		attr: { "aria-label": "Cancel" },
	});
	setIcon(cancelBtn, "x");
	cancelBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		handlers.onCancel();
	});

	const confirmBtn = actions.createEl("button", {
		cls: "dc-round dc-round--confirm",
		attr: { "aria-label": handlers.allowEmpty ? "Highlight" : "Comment" },
	});
	setIcon(confirmBtn, "check");
	confirmBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		submit();
	});
	textarea.addEventListener("input", () => {
		confirmBtn.setAttribute("aria-label", handlers.allowEmpty && !textarea.value.trim() ? "Highlight" : "Comment");
	});

	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			handlers.onCancel();
		} else if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	});
	return { el, textarea };
};
