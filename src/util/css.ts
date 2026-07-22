/**
 * `CSS.escape` with a small fallback for runtimes that lack it. Only quotes and
 * backslashes are escaped in the fallback, which is all our `[data-cid="…"]`
 * attribute selectors need.
 */
export const cssEscape = (value: string): string => {
	const css = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
	return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
};

/** Selector for a comment's highlight span(s), by comment id. */
export const spanSelector = (id: string): string => {
	return `.doc-comment-span[data-cid="${cssEscape(id)}"]`;
};

/** The comment id of the highlight span an event landed on, or null. */
export const closestSpanId = (target: EventTarget | null): string | null => {
	const el = target instanceof Element ? target.closest(".doc-comment-span") : null;
	return el?.getAttribute("data-cid") ?? null;
};
