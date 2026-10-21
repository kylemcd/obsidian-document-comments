export const isHtmlElement = (value: unknown): value is HTMLElement => {
	if (typeof value !== "object" || value === null) return false;
	const node = value as Node;
	const htmlElement = node.ownerDocument?.defaultView?.HTMLElement;
	if (htmlElement) return value instanceof htmlElement;
	return node.nodeType === 1;
};

/** True while an IME is composing, so Enter picks a candidate instead of sending. keyCode 229 covers Safari, which fires the committing Enter with isComposing false. */
export const isImeComposing = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;
