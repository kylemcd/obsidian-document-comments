export const isHtmlElement = (value: unknown): value is HTMLElement => {
	if (typeof value !== "object" || value === null) return false;
	const node = value as Node;
	const htmlElement = node.ownerDocument?.defaultView?.HTMLElement;
	if (htmlElement) return value instanceof htmlElement;
	return node.nodeType === 1;
};

/** True while an IME is composing, so Enter picks a candidate instead of sending.
 *  WebKit (Safari, the iOS app) fires the committing Enter after compositionend,
 *  with `isComposing` false, so neither that flag nor a compositionend listener
 *  catches it. Its `keyCode` is still 229, the value every browser gives a key the
 *  IME handles. `keyCode` is deprecated, but nothing replaces it for this case. */
export const isImeComposing = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;
