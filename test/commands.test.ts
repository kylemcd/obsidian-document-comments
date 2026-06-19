import { describe, it, expect } from "vitest";
import type { App, TFile } from "obsidian";
import { insertCommentInFile } from "../src/editor/commands";
import { parseComments } from "../src/format/parse";

// A minimal `app.vault.process` stub: run the mutator over an in-memory string and
// keep the result. Mirrors how Obsidian applies the transform and returns the text.
function fakeApp(getDoc: () => string, setDoc: (s: string) => void): App {
	return {
		vault: {
			process: async (_file: TFile, fn: (data: string) => string) => {
				const next = fn(getDoc());
				setDoc(next);
				return next;
			},
		},
	} as unknown as App;
}

describe("insertCommentInFile", () => {
	it("writes a new comment to the file and returns its id", async () => {
		let doc = "We should ship on Friday regardless.\n";
		const from = doc.indexOf("ship on Friday");
		const to = from + "ship on Friday".length;
		const app = fakeApp(
			() => doc,
			(s) => (doc = s),
		);

		const result = await insertCommentInFile(app, {} as TFile, from, to, "Thursday?", "kyle");

		expect(result.isOk()).toBe(true);
		const id = result.unwrap();
		const comments = parseComments(doc);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.id).toBe(id);
		expect(comments[0]!.quote).toBe("ship on Friday");
		expect(comments[0]!.thread[0]!.text).toBe("Thursday?");
		expect(comments[0]!.thread[0]!.author).toBe("kyle");
	});

	it("errs and writes nothing for an empty range", async () => {
		let doc = "unchanged text";
		const app = fakeApp(
			() => doc,
			(s) => (doc = s),
		);

		const result = await insertCommentInFile(app, {} as TFile, 3, 3, "ignored", "kyle");

		expect(result.isErr()).toBe(true);
		expect(doc).toBe("unchanged text");
	});
});
