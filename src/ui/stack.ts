export type Placement = {
	top: number;
	height: number;
};

/**
 * Stack margin cards top-down without overlap: honor anchor order (by `top`),
 * and push each card past the previous one plus a gap. Returns the resolved top
 * for each input in its ORIGINAL order.
 *
 * The first card's floor is -Infinity, so a card whose anchor has scrolled above
 * the viewport keeps a negative top and slides off the top edge instead of
 * sticking there in view.
 */
export const stackTops = (placements: Placement[], gap: number): number[] => {
	const order = placements.map((p, index) => ({ ...p, index })).sort((a, b) => a.top - b.top);
	const tops = Array.from<number>({ length: placements.length });
	let cursor = Number.NEGATIVE_INFINITY;
	for (const p of order) {
		const y = Math.max(p.top, cursor);
		tops[p.index] = y;
		cursor = y + p.height + gap;
	}
	return tops;
};
