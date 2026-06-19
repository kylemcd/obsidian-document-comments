import type { App, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { existingIds } from "../format/parse";
import { generateId } from "../format/ids";
import {
	applyChanges,
	computeAddComment,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeSetResolved,
	computeToggleReaction,
} from "./edits";

/** Wrap the range with anchor markers and append a body block; returns the new id. */
export const addComment = (view: EditorView, from: number, to: number, text: string, author: string): string | null => {
	const doc = view.state.doc.toString();
	const id = generateId(existingIds(doc));
	const changes = computeAddComment(doc, from, to, { id, createdAt: now(), author, text });
	if (!changes) return null;
	view.dispatch({ changes, scrollIntoView: false });
	return id;
};

/** Write a brand-new comment straight to a file on disk — for surfaces with no
 *  live CodeMirror view (reading view, and mobile where the margin composer is
 *  off). Returns the new id, or null if the range produced no change. */
export const insertCommentInFile = async (
	app: App,
	file: TFile,
	from: number,
	to: number,
	text: string,
	author: string,
): Promise<string | null> => {
	let newId: string | null = null;
	await app.vault.process(file, (data) => {
		const id = generateId(existingIds(data));
		const changes = computeAddComment(data, from, to, { id, createdAt: now(), author, text });
		if (!changes) return data;
		newId = id;
		return applyChanges(data, changes);
	});
	return newId;
};

export const appendReply = (view: EditorView, id: string, text: string, author: string): boolean => {
	const changes = computeAppendReply(view.state.doc.toString(), id, { createdAt: now(), author, text });
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

export const setResolved = (view: EditorView, id: string, resolved: boolean): boolean => {
	const changes = computeSetResolved(view.state.doc.toString(), id, resolved);
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

export const deleteComment = (view: EditorView, id: string): boolean => {
	const changes = computeDeleteComment(view.state.doc.toString(), id);
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

export const editEntry = (view: EditorView, id: string, index: number, text: string): boolean => {
	const changes = computeEditEntry(view.state.doc.toString(), id, index, text);
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

export const deleteEntry = (view: EditorView, id: string, index: number): boolean => {
	const changes = computeDeleteEntry(view.state.doc.toString(), id, index);
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

export const toggleReaction = (view: EditorView, id: string, emoji: string, author: string): boolean => {
	const changes = computeToggleReaction(view.state.doc.toString(), id, emoji, author);
	if (!changes) return false;
	view.dispatch({ changes });
	return true;
};

const now = (): string => {
	return new Date().toISOString();
};
