// The helpers Obsidian adds to every element, for tests that run real plugin UI.
type ElementOptions = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> };

const applyOptions = (element: HTMLElement, options?: ElementOptions): void => {
	if (typeof options === "string") element.className = options;
	else if (options) {
		if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
		if (options.text !== undefined) element.textContent = options.text;
		Object.entries(options.attr ?? {}).forEach(([name, value]) => element.setAttribute(name, value));
	}
};

export const installObsidianDom = (): void => {
	(globalThis as unknown as { createDiv: (options?: ElementOptions) => HTMLDivElement }).createDiv = (options) => {
		const element = document.createElement("div");
		applyOptions(element, options);
		return element;
	};
	HTMLElement.prototype.createDiv = function (options?: ElementOptions) {
		const element = this.ownerDocument.createElement("div");
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.createEl = function (tag: string, options?: ElementOptions) {
		const element = this.ownerDocument.createElement(tag);
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.createSpan = function (options?: ElementOptions) {
		const element = this.ownerDocument.createElement("span");
		applyOptions(element, options);
		this.appendChild(element);
		return element;
	};
	HTMLElement.prototype.detach = function () {
		this.remove();
	};
	HTMLElement.prototype.toggleClass = function (name: string, enabled: boolean) {
		this.classList.toggle(name, enabled);
	};
	HTMLElement.prototype.removeClasses = function (names: string[]) {
		this.classList.remove(...names);
	};
	HTMLElement.prototype.setCssStyles = function (styles: Partial<CSSStyleDeclaration>) {
		Object.assign(this.style, styles);
	};
	HTMLElement.prototype.addClass = function (...names: string[]) {
		this.classList.add(...names);
	};
	HTMLElement.prototype.removeClass = function (...names: string[]) {
		this.classList.remove(...names);
	};
	HTMLElement.prototype.empty = function () {
		this.replaceChildren();
	};
	HTMLElement.prototype.setText = function (text: string) {
		this.textContent = text;
	};
};
