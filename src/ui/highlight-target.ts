export const visibleHighlightId = (
	target: EventTarget | null,
	showComments: boolean,
	showResolved: boolean,
): string | null => {
	if (!showComments || !(target instanceof Element)) return null;
	const span = target.closest(".doc-comment-span");
	if (!(span instanceof HTMLElement)) return null;
	if (span.classList.contains("is-resolved") && !showResolved) return null;
	return span.getAttribute("data-cid");
};
