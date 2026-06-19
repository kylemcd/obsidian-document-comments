import { App, Modal, Setting } from "obsidian";

/**
 * A plain text-entry dialog for composing a new comment. Used where the inline
 * margin composer isn't available — i.e. on mobile, which has no floating column.
 * The caller supplies the quoted text (shown for context) and receives the entered
 * comment via `onSubmit`; the modal handles its own open/close.
 */
export class CommentModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private quote: string,
		private onSubmit: (text: string) => void,
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
			attr: { rows: "4", placeholder: "Write a comment…" },
		});
		input.addEventListener("input", () => {
			this.value = input.value;
		});
		// Cmd/Ctrl+Enter submits; plain Enter inserts a newline (room to type freely
		// on a small keyboard).
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit();
			}
		});
		window.setTimeout(() => input.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Comment")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	private submit(): void {
		const text = this.value.trim();
		this.close();
		if (text) this.onSubmit(text);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
