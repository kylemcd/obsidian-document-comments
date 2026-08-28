import { setIcon } from "obsidian";
import {
	draftPlaceholder,
	DraftSubmitHandler,
	EmptySubmitAction,
	emptySubmitLabel,
	submitDraft,
} from "./draft-behavior";

export type DraftComposerHandlers = {
	/** Called with the trimmed text on Enter or the confirm button. */
	onSubmit: DraftSubmitHandler;
	onCancel: () => void;
	authors?: () => string[];
	getAuthor?: () => string;
	/** Resolve the border color for the currently selected author. */
	colorForAuthor?: (author: string) => string | null;
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
): { el: HTMLElement; textarea: HTMLTextAreaElement; setEmptyAction: (action: EmptySubmitAction) => void } => {
	const el = createDiv("doc-comment-card is-draft");
	const box = el.createDiv("dc-field dc-field--composer");
	const initialEmptyAction = handlers.emptyAction ?? "none";
	let emptyLabel = emptySubmitLabel(initialEmptyAction);
	let saving = false;
	let selectedAuthor = handlers.getAuthor?.() ?? "me";
	const authors = [...new Set((handlers.authors?.() ?? []).map((author) => author.trim()).filter(Boolean))];
	if (!authors.includes(selectedAuthor)) authors.unshift(selectedAuthor);
	const canChooseAuthor = authors.length > 1;

	const applyAuthorColor = (author: string): void => {
		const color = handlers.colorForAuthor?.(author) ?? null;
		el.style.setProperty("--dc-composer-border-color", color ?? "var(--interactive-accent)");
	};
	applyAuthorColor(selectedAuthor);

	if (canChooseAuthor) {
		const author = box.createEl("select", { cls: "dc-field__author", attr: { "aria-label": "Comment author" } });
		authors.forEach((name) => author.createEl("option", { text: name, attr: { value: name } }));
		author.value = selectedAuthor;
		author.addEventListener("change", () => {
			selectedAuthor = author.value;
			applyAuthorColor(selectedAuthor);
		});
	}
	const textarea = box.createEl("textarea", {
		cls: "dc-field__input",
		attr: { placeholder: draftPlaceholder(initialEmptyAction), rows: "2" },
	});
	const actions = box.createDiv("dc-field__actions");
	const setSaving = (value: boolean): void => {
		saving = value;
		textarea.disabled = value;
		actions.querySelectorAll<HTMLButtonElement>("button").forEach((button) => (button.disabled = value));
	};
	const submit = async (): Promise<void> => {
		if (saving) return;
		setSaving(true);
		const result = await submitDraft(textarea.value, (text) =>
			canChooseAuthor ? handlers.onSubmit(text, selectedAuthor) : handlers.onSubmit(text),
		);
		if (result.isErr()) {
			setSaving(false);
			textarea.focus({ preventScroll: true });
		}
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
		attr: { "aria-label": emptyLabel },
	});
	setIcon(confirmBtn, "check");
	confirmBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		void submit();
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
			void submit();
		}
	});
	const setEmptyAction = (action: EmptySubmitAction): void => {
		emptyLabel = emptySubmitLabel(action);
		textarea.setAttribute("placeholder", draftPlaceholder(action));
		confirmBtn.setAttribute("aria-label", textarea.value.trim() ? "Comment" : emptyLabel);
	};
	return { el, textarea, setEmptyAction };
};
