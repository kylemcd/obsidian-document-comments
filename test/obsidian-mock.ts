export class App {}

export class Plugin {
	readonly app: App;

	constructor(app: App = new App()) {
		this.app = app;
	}

	async loadData(): Promise<unknown> {
		return null;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class Editor {}

export class TAbstractFile {
	constructor(readonly path = "") {}
}

export class TFile extends TAbstractFile {
	constructor(
		path = "",
		readonly extension = "md",
	) {
		super(path);
	}
}

export class WorkspaceLeaf {
	constructor(readonly view: unknown = null) {}
}

export class ItemView {
	readonly app = new App();
	readonly containerEl = document.createElement("div");
	readonly contentEl = document.createElement("div");

	constructor(readonly leaf: WorkspaceLeaf) {
		this.containerEl.appendChild(this.contentEl);
	}
}

export const Platform = { isMobile: false };

export const debounce = <Args extends unknown[]>(callback: (...args: Args) => void, delay: number) => {
	let timer: number | null = null;
	const debounced = (...args: Args): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			callback(...args);
		}, delay);
	};
	debounced.cancel = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	};
	return debounced;
};

export class MarkdownView {
	readonly containerEl = document.createElement("div");
	file: unknown = null;
	editor: unknown = {};

	getMode(): string {
		return "preview";
	}
}

export class Notice {
	constructor(readonly message: string) {}
}

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

	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}
}

class ValueComponent<T> {
	constructor(readonly inputEl: HTMLInputElement) {}

	setValue(value: T): this {
		if (typeof value === "boolean") this.inputEl.checked = value;
		else this.inputEl.value = String(value);
		return this;
	}

	onChange(callback: (value: T) => void): this {
		this.inputEl.addEventListener("change", () => {
			const value = (this.inputEl.type === "checkbox" ? this.inputEl.checked : this.inputEl.value) as T;
			callback(value);
		});
		return this;
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}
}

class ExtraButtonComponent extends ButtonComponent {
	setIcon(icon: string): this {
		this.buttonEl.dataset.icon = icon;
		return this;
	}

	setTooltip(tooltip: string): this {
		this.buttonEl.title = tooltip;
		return this;
	}
}

export class Setting {
	readonly settingEl: HTMLDivElement;
	private readonly nameEl: HTMLDivElement;
	private readonly descEl: HTMLDivElement;
	private readonly controlEl: HTMLDivElement;

	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		this.settingEl.className = "setting-item";
		this.nameEl = document.createElement("div");
		this.nameEl.className = "setting-item-name";
		this.descEl = document.createElement("div");
		this.descEl.className = "setting-item-description";
		this.controlEl = document.createElement("div");
		this.controlEl.className = "setting-item-control";
		this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string): this {
		this.nameEl.textContent = name;
		return this;
	}

	setDesc(description: string): this {
		this.descEl.textContent = description;
		return this;
	}

	setHeading(): this {
		this.settingEl.classList.add("setting-item-heading");
		return this;
	}

	addButton(configure: (button: ButtonComponent) => void): this {
		const button = document.createElement("button");
		this.controlEl.appendChild(button);
		configure(new ButtonComponent(button));
		return this;
	}

	addExtraButton(configure: (button: ExtraButtonComponent) => void): this {
		const button = document.createElement("button");
		this.controlEl.appendChild(button);
		configure(new ExtraButtonComponent(button));
		return this;
	}

	addText(configure: (component: ValueComponent<string>) => void): this {
		const input = document.createElement("input");
		input.type = "text";
		this.controlEl.appendChild(input);
		configure(new ValueComponent(input));
		return this;
	}

	addToggle(configure: (component: ValueComponent<boolean>) => void): this {
		const input = document.createElement("input");
		input.type = "checkbox";
		this.controlEl.appendChild(input);
		configure(new ValueComponent(input));
		return this;
	}

	addColorPicker(configure: (component: ValueComponent<string>) => void): this {
		const input = document.createElement("input");
		input.type = "color";
		this.controlEl.appendChild(input);
		configure(new ValueComponent(input));
		return this;
	}
}

export class PluginSettingTab {
	readonly containerEl = document.createElement("div");

	constructor(
		readonly app: App,
		readonly plugin: unknown,
	) {}

	update(): void {}
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
