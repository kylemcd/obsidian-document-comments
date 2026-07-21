/** Center a document block in a scroll viewport, clamped to both scroll edges. */
export const centeredScrollTop = (
	blockTop: number,
	blockHeight: number,
	viewportHeight: number,
	scrollHeight: number,
): number => {
	const centered = blockTop + blockHeight / 2 - viewportHeight / 2;
	return Math.max(0, Math.min(centered, Math.max(0, scrollHeight - viewportHeight)));
};
