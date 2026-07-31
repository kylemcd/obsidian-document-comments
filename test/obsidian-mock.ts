export class App {}

export class Modal {
	readonly contentEl = document.createElement("div");
	readonly titleEl = document.createElement("div");
	private readonly modalEl = document.createElement("div");

	constructor(_app: App) {
		this.modalEl.append(this.titleEl, this.contentEl);
	}

	open(): void {
		document.body.appendChild(this.modalEl);
		this.onOpen();
	}

	close(): void {
		this.onClose();
		this.modalEl.remove();
	}

	onOpen(): void {}
	onClose(): void {}
}

class ButtonComponent {
	constructor(readonly buttonEl: HTMLButtonElement) {}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	onClick(callback: () => void): this {
		this.buttonEl.addEventListener("click", callback);
		return this;
	}

	setCta(): this {
		return this;
	}
}

export class Setting {
	private readonly settingEl: HTMLDivElement;

	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		containerEl.appendChild(this.settingEl);
	}

	addButton(configure: (button: ButtonComponent) => void): this {
		const button = document.createElement("button");
		this.settingEl.appendChild(button);
		configure(new ButtonComponent(button));
		return this;
	}
}

export class Component {
	load(): void {}
	unload(): void {}
}

export const MarkdownRenderer = {
	render: async (): Promise<void> => {},
};

class MenuItem {
	setTitle(): this {
		return this;
	}

	setIcon(): this {
		return this;
	}

	onClick(): this {
		return this;
	}
}

export class Menu {
	addItem(configure: (item: MenuItem) => void): this {
		configure(new MenuItem());
		return this;
	}

	showAtMouseEvent(): void {}
}

export const setIcon = (): void => {};
