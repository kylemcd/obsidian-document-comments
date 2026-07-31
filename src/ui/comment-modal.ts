import { App, Modal, Setting } from "obsidian";
import {
	draftPlaceholder,
	DraftSubmitHandler,
	EmptySubmitAction,
	emptySubmitLabel,
	submitDraft,
} from "./draft-behavior";

/**
 * A plain text-entry dialog for composing a new comment. Used where the inline
 * margin composer isn't available — i.e. on mobile, which has no floating column.
 * The caller supplies the quoted text (shown for context) and receives the entered
 * comment via `onSubmit`; the modal handles its own open/close.
 */
export class CommentModal extends Modal {
	private value = "";
	private saving = false;

	constructor(
		app: App,
		private quote: string,
		private onSubmit: DraftSubmitHandler,
		private emptyAction: EmptySubmitAction = "none",
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Add comment");

		const quote = this.quote.trim();
		if (quote) contentEl.createDiv({ cls: "dc-modal-quote", text: quote });

		const input = contentEl.createEl("textarea", {
			cls: "dc-modal-input",
			attr: {
				rows: "4",
				placeholder: draftPlaceholder(this.emptyAction),
			},
		});
		input.addEventListener("input", () => {
			this.value = input.value;
		});
		// Cmd/Ctrl+Enter submits; plain Enter inserts a newline (room to type freely
		// on a small keyboard).
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void this.submit();
			}
		});
		window.setTimeout(() => input.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				const updateLabel = () => {
					const emptyLabel = emptySubmitLabel(this.emptyAction);
					b.setButtonText(!this.value.trim() && this.emptyAction !== "none" ? emptyLabel : "Comment");
				};
				input.addEventListener("input", updateLabel);
				updateLabel();
				b.setCta().onClick(() => void this.submit());
			});
	}

	private async submit(): Promise<void> {
		if (this.saving) return;
		const text = this.value.trim();
		this.saving = true;
		this.contentEl
			.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>("textarea, button")
			.forEach((control) => (control.disabled = true));
		const result = await submitDraft(text, this.onSubmit);
		if (result.isOk()) {
			this.close();
			return;
		}
		this.saving = false;
		this.contentEl
			.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>("textarea, button")
			.forEach((control) => (control.disabled = false));
		this.contentEl.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
	}

	onClose(): void {
		this.saving = false;
		this.contentEl.empty();
	}
}
