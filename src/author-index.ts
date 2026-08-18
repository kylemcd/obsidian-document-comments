import type { TFile, Vault } from "obsidian";
import { Result } from "better-result";
import { commentersForComments } from "./author-colors";
import { parseComments } from "./format/parse";

export type AuthorIndexError = {
	path: string;
	message: string;
};

export type AuthorIndexState =
	| { status: "idle"; authors: string[] }
	| { status: "scanning"; authors: string[] }
	| { status: "ready"; authors: string[] }
	| { status: "partial"; authors: string[]; errors: AuthorIndexError[] };

export type AuthorIndex = {
	getState: () => AuthorIndexState;
	subscribe: (listener: (state: AuthorIndexState) => void) => () => void;
	scan: () => Promise<AuthorIndexState>;
	scheduleRefresh: (file: TFile) => void;
	remove: (path: string) => void;
	rename: (file: TFile, oldPath: string) => void;
	dispose: () => void;
};

type ReadSuccess = {
	path: string;
	authors: Set<string>;
};

type ReadRequest = {
	file: TFile;
	path: string;
	revision: number;
};

type VersionedReadResult = {
	path: string;
	revision: number;
	result: Result<ReadSuccess, AuthorIndexError>;
};

const SCAN_BATCH_SIZE = 8;
const REFRESH_DELAY_MS = 150;

const errorMessage = (error: unknown): string => {
	return error instanceof Error ? error.message : "Unknown read error";
};

const markdownFile = (file: TFile): boolean => file.extension.toLowerCase() === "md";

export const createAuthorIndex = (vault: Pick<Vault, "getMarkdownFiles" | "cachedRead">): AuthorIndex => {
	const fileAuthors = new Map<string, Set<string>>();
	const errors = new Map<string, AuthorIndexError>();
	const listeners = new Set<(state: AuthorIndexState) => void>();
	const refreshTimers = new Map<string, number>();
	const revisions = new Map<string, number>();
	let state: AuthorIndexState = { status: "idle", authors: [] };

	const nextRevision = (path: string): number => {
		const revision = (revisions.get(path) ?? 0) + 1;
		revisions.set(path, revision);
		return revision;
	};

	const aggregateAuthors = (): string[] => {
		return [...new Set([...fileAuthors.values()].flatMap((authors) => [...authors]))].sort((a, b) =>
			a.localeCompare(b),
		);
	};

	const publish = (status?: "idle" | "scanning" | "ready" | "partial"): AuthorIndexState => {
		const authors = aggregateAuthors();
		const failures = [...errors.values()].sort((a, b) => a.path.localeCompare(b.path));
		const nextStatus = status ?? (failures.length > 0 ? "partial" : "ready");
		state =
			nextStatus === "partial"
				? { status: "partial", authors, errors: failures }
				: { status: nextStatus, authors };
		listeners.forEach((listener) => listener(state));
		return state;
	};

	const requestRead = (file: TFile): ReadRequest => {
		const path = file.path;
		return { file, path, revision: nextRevision(path) };
	};

	const readFile = async ({ file, path, revision }: ReadRequest): Promise<VersionedReadResult> => {
		const result = await Result.tryPromise({
			try: async () => {
				const content = await vault.cachedRead(file);
				const authors = content.includes("<!--co:")
					? new Set(commentersForComments(parseComments(content)))
					: new Set<string>();
				return { path, authors };
			},
			catch: (error) => ({ path, message: errorMessage(error) }),
		});
		return { path, revision, result };
	};

	const applyResults = (results: readonly VersionedReadResult[]): void => {
		const current = results
			.filter(({ path, revision }) => revisions.get(path) === revision)
			.map(({ result }) => result);
		const [successes, failures] = Result.partition(current);
		successes.forEach(({ path, authors }) => {
			fileAuthors.set(path, authors);
			errors.delete(path);
		});
		failures.forEach((failure) => errors.set(failure.path, failure));
	};

	const scan = async (): Promise<AuthorIndexState> => {
		publish("scanning");
		const files = vault.getMarkdownFiles().filter(markdownFile);
		const requests = files.map(requestRead);
		const currentPaths = new Set(requests.map(({ path }) => path));
		[...fileAuthors.keys()]
			.filter((path) => !currentPaths.has(path))
			.forEach((path) => {
				nextRevision(path);
				fileAuthors.delete(path);
			});
		[...errors.keys()].filter((path) => !currentPaths.has(path)).forEach((path) => errors.delete(path));

		// Bounded batches prevent a large vault from starting every read at once.
		for (let from = 0; from < requests.length; from += SCAN_BATCH_SIZE) {
			const batch = requests.slice(from, from + SCAN_BATCH_SIZE);
			applyResults(await Promise.all(batch.map(readFile)));
		}
		return publish();
	};

	const refresh = async (file: TFile): Promise<void> => {
		if (!markdownFile(file)) {
			fileAuthors.delete(file.path);
			errors.delete(file.path);
			publish();
			return;
		}
		applyResults([await readFile(requestRead(file))]);
		publish();
	};

	const scheduleRefresh = (file: TFile): void => {
		nextRevision(file.path);
		const existing = refreshTimers.get(file.path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			refreshTimers.delete(file.path);
			void refresh(file);
		}, REFRESH_DELAY_MS);
		refreshTimers.set(file.path, timer);
	};

	const remove = (path: string): void => {
		nextRevision(path);
		const timer = refreshTimers.get(path);
		if (timer) window.clearTimeout(timer);
		refreshTimers.delete(path);
		fileAuthors.delete(path);
		errors.delete(path);
		publish();
	};

	const rename = (file: TFile, oldPath: string): void => {
		const authors = fileAuthors.get(oldPath);
		const failure = errors.get(oldPath);
		remove(oldPath);
		if (authors) fileAuthors.set(file.path, authors);
		if (failure) errors.set(file.path, { ...failure, path: file.path });
		publish();
		scheduleRefresh(file);
	};

	const dispose = (): void => {
		refreshTimers.forEach((timer) => window.clearTimeout(timer));
		refreshTimers.clear();
		revisions.clear();
		listeners.clear();
	};

	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		scan,
		scheduleRefresh,
		remove,
		rename,
		dispose,
	};
};
