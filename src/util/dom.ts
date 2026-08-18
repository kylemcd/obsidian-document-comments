export const isHtmlElement = (value: unknown): value is HTMLElement => {
	if (typeof value !== "object" || value === null) return false;
	const node = value as Node;
	const htmlElement = node.ownerDocument?.defaultView?.HTMLElement;
	if (htmlElement) return value instanceof htmlElement;
	return node.nodeType === 1;
};
