import { setIcon } from "obsidian";
import { draftPlaceholder, EmptySubmitAction, emptySubmitLabel, submitDraft } from "./draft-behavior";

export type DraftComposerHandlers = {
	/** Called with the trimmed text on Enter or the confirm button. */
	onSubmit: (text: string) => void;
	onCancel: () => void;
	/** What an empty confirmation does. The caller applies the action. */
	emptyAction?: EmptySubmitAction;
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
	const emptyAction = handlers.emptyAction ?? "none";
	const textarea = box.createEl("textarea", {
		cls: "dc-field__input",
		attr: { placeholder: draftPlaceholder(emptyAction), rows: "2" },
	});
	const actions = box.createDiv("dc-field__actions");
	const submit = () => submitDraft(textarea.value, handlers.onSubmit);
	const emptyLabel = emptySubmitLabel(emptyAction);

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
		attr: { "aria-label": emptyLabel },
	});
	setIcon(confirmBtn, "check");
	confirmBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		submit();
	});
	textarea.addEventListener("input", () => {
		confirmBtn.setAttribute("aria-label", textarea.value.trim() ? "Comment" : emptyLabel);
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
