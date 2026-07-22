import type { App, TFile } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { existingIds } from "../format/parse";
import { generateId } from "../format/ids";
import {
	Change,
	applyChanges,
	computeAddComment,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	computeToggleReaction,
} from "./edits";

/** Wrap the range with anchor markers and append a body block; ok carries the new id. */
export const addComment = (
	view: EditorView,
	from: number,
	to: number,
	text: string,
	author: string,
	expected?: string,
): Result<string, string> => {
	const doc = view.state.doc.toString();
	const id = generateId(existingIds(doc));
	return computeAddComment(doc, from, to, { id, createdAt: now(), author, text, expected }).map((changes) => {
		view.dispatch({ changes, scrollIntoView: false });
		return id;
	});
};

export const appendReply = (view: EditorView, id: string, text: string, author: string): Result<void, string> => {
	return computeAppendReply(view.state.doc.toString(), id, { createdAt: now(), author, text }).map((changes) => {
		view.dispatch({ changes });
	});
};

export const setResolved = (view: EditorView, id: string, resolved: boolean): Result<void, string> => {
	return computeSetResolved(view.state.doc.toString(), id, resolved).map((changes) => {
		view.dispatch({ changes });
	});
};

export const deleteComment = (view: EditorView, id: string): Result<void, string> => {
	return computeDeleteComment(view.state.doc.toString(), id).map((changes) => {
		view.dispatch({ changes });
	});
};

export const editEntry = (view: EditorView, id: string, index: number, text: string): Result<void, string> => {
	return computeEditEntry(view.state.doc.toString(), id, index, text).map((changes) => {
		view.dispatch({ changes });
	});
};

export const deleteEntry = (view: EditorView, id: string, index: number): Result<void, string> => {
	return computeDeleteEntry(view.state.doc.toString(), id, index).map((changes) => {
		view.dispatch({ changes });
	});
};

export const toggleReaction = (view: EditorView, id: string, emoji: string, author: string): Result<void, string> => {
	return computeToggleReaction(view.state.doc.toString(), id, emoji, author).map((changes) => {
		view.dispatch({ changes });
	});
};

/** Narrow a caught `unknown` to a message. */
export const errorMessage = (e: unknown): string => {
	return e instanceof Error ? e.message : "unknown error";
};

/** Run a computed edit against a file through `vault.process` and fold the
 *  compute error, the I/O error, and the success into one Result carrying the
 *  new document text. The compute runs on FRESH data inside the callback, so it
 *  never races another writer; an I/O failure wins over a provisional success. */
export const processFileEdit = async (
	app: App,
	file: TFile,
	compute: (doc: string) => Result<Change[], string>,
): Promise<Result<string, string>> => {
	let computeError: string | undefined;
	const io = await Result.tryPromise({
		try: () =>
			app.vault.process(file, (data) => {
				const result = compute(data);
				if (result.isErr()) {
					computeError = result.error;
					return data;
				}
				return applyChanges(data, result.value);
			}),
		catch: errorMessage,
	});
	return computeError ? Result.err(computeError) : io;
};

/** Write a brand-new comment straight to a file on disk — for surfaces with no
 *  live CodeMirror view (reading view, and mobile where the margin composer is
 *  off). Ok carries the new id; Err carries a reason (I/O failure or empty range). */
export const insertCommentInFile = async (
	app: App,
	file: TFile,
	from: number,
	to: number,
	text: string,
	author: string,
	expected?: string,
): Promise<Result<string, string>> => {
	let computed: Result<string, string> = Result.err("No change was written.");
	const io = await Result.tryPromise({
		try: () =>
			app.vault.process(file, (data) => {
				const id = generateId(existingIds(data));
				const result = computeAddComment(data, from, to, { id, createdAt: now(), author, text, expected });
				if (result.isErr()) {
					computed = Result.err(result.error);
					return data;
				}
				computed = Result.ok(id);
				return applyChanges(data, result.value);
			}),
		catch: errorMessage,
	});
	// Surface an I/O failure; otherwise the compute outcome (id, or the reason nothing was written).
	return io.isErr() ? Result.err(io.error) : computed;
};

const now = (): string => {
	return new Date().toISOString();
};
