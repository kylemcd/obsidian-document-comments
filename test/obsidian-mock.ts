export class App {}

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
