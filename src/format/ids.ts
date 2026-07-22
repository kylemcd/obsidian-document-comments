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
	return Array.from({ length: len }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
};
