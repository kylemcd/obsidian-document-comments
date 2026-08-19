import type { App, TFile } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { existingIds } from "../format/parse";
import { generateId } from "../format/ids";
import type { ReactionTarget } from "../format/types";
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
	findHighlightAtSelection,
} from "./edits";

/** Create a comment/highlight, or update an exact matching highlight. Ok carries
 *  the affected id, or an empty string when a disabled blank submit writes nothing. */
export const addComment = (
	view: EditorView,
	from: number,
	to: number,
	text: string,
	author: string,
	expected?: string,
	allowEmpty = true,
	targetHighlightId?: string,
): Result<string, string> => {
	const doc = view.state.doc.toString();
	const highlight = findHighlightAtSelection(doc, from, to);
	const id = targetHighlightId ?? highlight?.id ?? generateId(existingIds(doc));
	return computeAddComment(doc, from, to, {
		id,
		createdAt: now(),
		author,
		text,
		expected,
		allowEmpty,
		targetHighlightId,
	}).map((changes) => {
		if (changes.length > 0) view.dispatch({ changes, scrollIntoView: false });
		return changes.length > 0 ? id : "";
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

export type ToggleReactionCommandInput = ReactionTarget & {
	view: EditorView;
	author: string;
};

export const toggleReaction = ({
	view,
	id,
	entry,
	emoji,
	author,
}: ToggleReactionCommandInput): Result<void, string> => {
	return computeToggleReaction({ doc: view.state.doc.toString(), id, entry, emoji, author }).map((changes) => {
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

/** Create or manage a comment straight in a file for surfaces without a live
 *  CodeMirror view. Ok carries the affected id, or an empty string for a no-op. */
export const insertCommentInFile = async (
	app: App,
	file: TFile,
	from: number,
	to: number,
	text: string,
	author: string,
	expected?: string,
	allowEmpty = true,
	targetHighlightId?: string,
): Promise<Result<string, string>> => {
	let computed: Result<string, string> = Result.err("No change was written.");
	const io = await Result.tryPromise({
		try: () =>
			app.vault.process(file, (data) => {
				const highlight = findHighlightAtSelection(data, from, to);
				const id = targetHighlightId ?? highlight?.id ?? generateId(existingIds(data));
				const result = computeAddComment(data, from, to, {
					id,
					createdAt: now(),
					author,
					text,
					expected,
					allowEmpty,
					targetHighlightId,
				});
				if (result.isErr()) {
					computed = Result.err(result.error);
					return data;
				}
				computed = Result.ok(result.value.length > 0 ? id : "");
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
