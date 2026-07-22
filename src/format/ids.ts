const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a short, collision-resistant id unique within `existing`. */
export const generateId = (existing: Iterable<string> = []): string => {
	const taken = existing instanceof Set ? existing : new Set(existing);
	for (let attempt = 0; attempt < 1000; attempt++) {
		const id = randomId(5);
		if (!taken.has(id)) return id;
	}
	return randomId(8);
};

const randomId = (len: number): string => {
	// Tight character-by-character build from a fixed alphabet; no array-method
	// form is clearer here.
	let out = "";
	for (let i = 0; i < len; i++) {
		out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
	}
	return out;
};
