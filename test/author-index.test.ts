// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TFile, Vault } from "obsidian";
import { createAuthorIndex } from "../src/author-index";

type FakeFile = TFile & { path: string; extension: string };

const file = (path: string): FakeFile => ({ path, extension: "md" }) as FakeFile;
const body = (id: string, author: string): string => `<!--co:${id} by:${author} status:open\n${author}: hi\n-->`;

afterEach(() => vi.useRealTimers());

describe("author index", () => {
	test("deduplicates creators and retains usable data after read failures", async () => {
		const files = [file("a.md"), file("b.md"), file("broken.md")];
		const vault = {
			getMarkdownFiles: () => files,
			cachedRead: async (target: FakeFile) => {
				if (target.path === "broken.md") throw new Error("permission denied");
				return target.path === "a.md" ? `${body("a", "Alice")}\n${body("b", "Alice")}` : body("c", "Bob");
			},
		} as unknown as Pick<Vault, "getMarkdownFiles" | "cachedRead">;
		const index = createAuthorIndex(vault);

		await expect(index.scan()).resolves.toEqual({
			status: "partial",
			authors: ["Alice", "Bob"],
			errors: [{ path: "broken.md", message: "permission denied" }],
		});
	});

	test("updates per-file creators across modify, rename, and delete events", async () => {
		vi.useFakeTimers();
		const note = file("note.md");
		const files = [note];
		const contents = new Map([[note.path, body("a", "Alice")]]);
		const vault = {
			getMarkdownFiles: () => files,
			cachedRead: async (target: FakeFile) => contents.get(target.path) ?? "",
		} as unknown as Pick<Vault, "getMarkdownFiles" | "cachedRead">;
		const index = createAuthorIndex(vault);
		await index.scan();

		contents.set(note.path, body("b", "Bob"));
		index.scheduleRefresh(note);
		await vi.runAllTimersAsync();
		expect(index.getState().authors).toEqual(["Bob"]);

		const renamed = file("renamed.md");
		contents.set(renamed.path, body("b", "Bob"));
		index.rename(renamed, note.path);
		expect(index.getState().authors).toEqual(["Bob"]);
		await vi.runAllTimersAsync();

		index.remove(renamed.path);
		expect(index.getState()).toEqual({ status: "ready", authors: [] });
	});

	test("retains the last successful creator set when a refresh fails", async () => {
		vi.useFakeTimers();
		const note = file("note.md");
		let fail = false;
		const vault = {
			getMarkdownFiles: () => [note],
			cachedRead: async () => {
				if (fail) throw new Error("temporarily locked");
				return body("a", "Alice");
			},
		} as unknown as Pick<Vault, "getMarkdownFiles" | "cachedRead">;
		const index = createAuthorIndex(vault);
		await index.scan();

		fail = true;
		index.scheduleRefresh(note);
		await vi.runAllTimersAsync();

		expect(index.getState()).toEqual({
			status: "partial",
			authors: ["Alice"],
			errors: [{ path: "note.md", message: "temporarily locked" }],
		});
	});

	test("does not let stale full-scan reads undo newer modify and delete events", async () => {
		vi.useFakeTimers();
		const modified = file("modified.md");
		const deleted = file("deleted.md");
		let resolveModifiedScan: (content: string) => void = () => {};
		let resolveDeletedScan: (content: string) => void = () => {};
		let modifiedReads = 0;
		const vault = {
			getMarkdownFiles: () => [modified, deleted],
			cachedRead: async (target: FakeFile) => {
				if (target.path === modified.path && modifiedReads++ > 0) return body("new", "Bob");
				return new Promise<string>((resolve) => {
					if (target.path === modified.path) resolveModifiedScan = resolve;
					else resolveDeletedScan = resolve;
				});
			},
		} as unknown as Pick<Vault, "getMarkdownFiles" | "cachedRead">;
		const index = createAuthorIndex(vault);
		const scan = index.scan();

		index.scheduleRefresh(modified);
		index.remove(deleted.path);
		await vi.runAllTimersAsync();
		expect(index.getState().authors).toEqual(["Bob"]);

		resolveModifiedScan(body("old", "Alice"));
		resolveDeletedScan(body("gone", "Carol"));
		await scan;

		expect(index.getState()).toEqual({ status: "ready", authors: ["Bob"] });
	});

	test("does not scan a deleted file that was still waiting in a later batch", async () => {
		const files = Array.from({ length: 9 }, (_, index) => file(`note-${index}.md`));
		const deleted = files[8]!;
		let releaseFirstBatch: () => void = () => {};
		const firstBatch = new Promise<void>((resolve) => {
			releaseFirstBatch = resolve;
		});
		const vault = {
			getMarkdownFiles: () => files,
			cachedRead: async (target: FakeFile) => {
				if (target.path === deleted.path) return body("gone", "Carol");
				await firstBatch;
				return "";
			},
		} as unknown as Pick<Vault, "getMarkdownFiles" | "cachedRead">;
		const index = createAuthorIndex(vault);
		const scan = index.scan();

		index.remove(deleted.path);
		releaseFirstBatch();
		await scan;

		expect(index.getState()).toEqual({ status: "ready", authors: [] });
	});
});
