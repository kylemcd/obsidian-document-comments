import {
	Component,
	Editor,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	debounce,
} from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { commentField, refreshCommentColors } from "./editor/state";
import { marginPlugin } from "./editor/margin";
import { commentConfig } from "./editor/config";
import { editorLayoutField } from "./editor/layout";
import { draftField, setDraft } from "./editor/draft";
import { addComment, insertCommentInFile } from "./editor/commands";
import { findHighlightAtSelection } from "./editor/edits";
import { findSectionRange, highlightPostProcessor, mapReadingSelection } from "./reading/highlight";
import { ReadingDeps, ReadingMarginManager } from "./reading/margin";
import { COMMENTS_VIEW_TYPE, CommentsSidebarView, SidebarDeps } from "./ui/sidebar";
import { CommentModal } from "./ui/comment-modal";
import { DEFAULT_SETTINGS, DocCommentsSettings, DocCommentsSettingTab } from "./settings";
import { tableHighlightPlugin } from "./editor/table-highlights";
import {
	authorColorCss,
	canonicalAuthorKey,
	ensureAuthorColor,
	ensureAuthorColors,
	effectiveHighlightColor,
	hydrateAuthorColors,
	hydrateExcludedAuthors,
	parseHexColor,
	resolveAuthorColor,
	type AuthorColorAssignment,
	type ResolvedAuthorColor,
} from "./author-colors";
import { createAuthorIndex, type AuthorIndex, type AuthorIndexState } from "./author-index";
import { loadSettingsData, saveSettingsData } from "./settings-storage";
import { isHtmlElement } from "./util/dom";

type AuthorColorStateSnapshot = {
	assignment: AuthorColorAssignment | undefined;
	excluded: boolean;
};

export default class DocCommentsPlugin extends Plugin {
	settings: DocCommentsSettings = { ...DEFAULT_SETTINGS, authorColors: {}, excludedAuthorColors: [] };
	private markdown = new Component();
	private ribbonIcon: HTMLElement | null = null;
	private readingManager: ReadingMarginManager | null = null;
	private scheduleReadingRefresh: () => void = () => {};
	private authorIndex: AuthorIndex | null = null;
	private unsubscribeAuthorIndex: (() => void) | null = null;
	private settingsTab: DocCommentsSettingTab | null = null;
	private settingsPersistenceError: string | null = null;
	private authorIndexError: string | null = null;
	private excludedAuthorColorSet = new Set<string>();
	private scheduleAuthorColorSave = debounce(() => void this.persistAuthorColors(), 100, true);
	/** True while the "All discussions" sidebar panel is mounted. */
	private sidebarOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addChild(this.markdown);
		this.authorIndex = createAuthorIndex(this.app.vault);
		this.unsubscribeAuthorIndex = this.authorIndex.subscribe((state) => this.handleAuthorIndexState(state));

		this.registerEditorExtension([
			commentField,
			tableHighlightPlugin,
			draftField,
			commentConfig.of({
				app: this.app,
				renderMarkdown: (markdown, el) =>
					MarkdownRenderer.render(
						this.app,
						markdown,
						el,
						this.app.workspace.getActiveFile()?.path ?? "",
						this.markdown,
					),
				author: () => this.authorName(),
				colorForAuthor: (author) => this.colorForAuthor(author),
				highlightColorForAuthor: (author) => this.highlightColorForAuthor(author),
				showComments: () => this.settings.showComments,
				showResolved: () => this.settings.showResolved,
				allowEmptyComments: () => this.settings.allowEmptyComments,
				sidebarOpen: () => this.sidebarOpen,
				openInSidebar: (id) => void this.revealComment(id),
				isMobile: () => Platform.isMobile,
			}),
			// Reflects dc-has / dc-highlights / dc-hide-resolved onto .cm-editor so the
			// stylesheet caps the text column without a :has() selector.
			editorLayoutField,
			// The floating margin column needs horizontal room mobile doesn't have, so
			// there we skip it entirely — comments live in the sidebar, highlights stay,
			// and new comments are composed in a modal (see startAddComment).
			...(Platform.isMobile ? [] : [marginPlugin]),
		]);

		// Reading view: a separate render path. Highlights come from a post-processor;
		// the margin column is managed per reading-view container.
		const readingDeps: ReadingDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
			colorForAuthor: (author) => this.colorForAuthor(author),
			highlightColorForAuthor: (author) => this.highlightColorForAuthor(author),
			showComments: () => this.settings.showComments,
			showResolved: () => this.settings.showResolved,
			allowEmptyComments: () => this.settings.allowEmptyComments,
			sidebarOpen: () => this.sidebarOpen,
			openInSidebar: (id) => void this.revealComment(id),
			isMobile: () => Platform.isMobile,
		};
		this.readingManager = new ReadingMarginManager(readingDeps);
		this.scheduleReadingRefresh = debounce(() => this.readingManager?.refresh(), 50, true);

		// The "All discussions" sidebar panel (Notion-style). While it's open the
		// inline floating cards step aside; the in-text highlights stay.
		const sidebarDeps: SidebarDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
			colorForAuthor: (author) => this.colorForAuthor(author),
		};
		this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsSidebarView(leaf, sidebarDeps));

		this.registerMarkdownPostProcessor((el, ctx) => {
			highlightPostProcessor(el, ctx, (author) => this.highlightColorForAuthor(author), this.authorName());
			this.scheduleReadingRefresh();
		});
		// layout-change / active-leaf-change fire for every way the panel shows or
		// hides — open, close, collapse the dock, switch tabs — so the inline column
		// follows the panel's real visibility instead of a mount flag that misses
		// collapse/tab-switch.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		// resize fires while a dock collapses/expands — catches that case promptly
		// even if layout-change doesn't.
		this.registerEvent(this.app.workspace.on("resize", () => this.syncSidebarOpen()));
		this.app.workspace.onLayoutReady(() => {
			// Register after vault startup so Obsidian's initial create-event burst does
			// not duplicate a scan when author colors are enabled.
			this.registerEvent(
				this.app.vault.on("create", (file: TAbstractFile) => {
					if (this.settings.authorColorsEnabled && file instanceof TFile) {
						this.authorIndex?.scheduleRefresh(file);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("modify", (file: TAbstractFile) => {
					this.scheduleReadingRefresh();
					if (this.settings.authorColorsEnabled && file instanceof TFile) {
						this.authorIndex?.scheduleRefresh(file);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (file: TAbstractFile) => {
					if (this.settings.authorColorsEnabled) this.authorIndex?.remove(file.path);
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
					if (!this.settings.authorColorsEnabled) return;
					if (file instanceof TFile) this.authorIndex?.rename(file, oldPath);
					else this.authorIndex?.remove(oldPath);
				}),
			);
			void this.scanAuthorsIfEnabled();
		});

		this.addCommand({
			id: "add-comment",
			name: "Add comment",
			editorCallback: (editor) => this.startAddComment(editor),
		});

		this.addCommand({
			id: "toggle-comments",
			name: "Toggle comments",
			callback: () => void this.toggleComments(),
		});

		this.addCommand({
			id: "toggle-resolved",
			name: "Toggle resolved comments",
			callback: () => void this.toggleResolved(),
		});

		this.addCommand({
			id: "add-comment-reading",
			name: "Add comment in reading view",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.getMode() !== "preview") return false;
				if (!checking) this.startAddCommentReading(view);
				return true;
			},
		});

		this.addCommand({
			id: "open-comments-sidebar",
			name: "Open comments sidebar",
			callback: () => void this.activateSidebar(),
		});

		this.ribbonIcon = this.addRibbonIcon(
			"message-square",
			"Toggle document comments",
			() => void this.toggleComments(),
		);
		this.updateRibbon();
		this.addRibbonIcon("messages-square", "Open comments sidebar", () => void this.activateSidebar());

		this.settingsTab = new DocCommentsSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
	}

	private startAddComment(editor: Editor): void {
		const view = editorView(editor);
		if (!view) {
			new Notice("Couldn't access the editor.");
			return;
		}
		const { from, to, empty } = view.state.selection.main;
		if (empty) {
			new Notice("Select some text to comment on.");
			return;
		}
		const doc = view.state.doc.toString();
		const targetHighlightId = findHighlightAtSelection(doc, from, to)?.id;
		if (Platform.isMobile) {
			// No floating margin composer on mobile — collect the text in a modal,
			// then write through the same editor path so it's a single undo step.
			const quote = view.state.doc.sliceString(from, to);
			const emptyAction = targetHighlightId ? "remove" : this.settings.allowEmptyComments ? "highlight" : "none";
			new CommentModal(
				this.app,
				quote,
				(text) => {
					// Pass the captured selection so a doc that shifted while the modal was
					// open (sync, another pane) is caught instead of mis-anchoring.
					const result = addComment(
						view,
						from,
						to,
						text,
						this.authorName(),
						quote,
						this.settings.allowEmptyComments,
						targetHighlightId,
					);
					if (result.isErr()) new Notice(`Couldn't add the comment: ${result.error}`);
					return result.map(() => undefined);
				},
				emptyAction,
			).open();
			return;
		}
		// Show a draft composer card in the margin (Notion-style) instead of a modal.
		view.dispatch({ effects: setDraft.of({ from, to, targetHighlightId }) });
	}

	/** Reading view has no editor surface, so map the rendered selection back to
	 *  source offsets (best-effort) and prompt for the comment text. */
	private startAddCommentReading(view: MarkdownView): void {
		const selection = activeWindow.getSelection();
		const selected = selection?.toString() ?? "";
		if (!selection || selection.rangeCount === 0 || !selected.trim()) {
			new Notice("Select some text to comment on.");
			return;
		}
		const section = selection.anchorNode ? findSectionRange(selection.anchorNode) : null;
		if (!section) {
			new Notice("Couldn't locate that selection in the note.");
			return;
		}
		// The selection may sit inside an embed or a hover preview — a different
		// file's rendered block. Its offsets are meaningless in the host file, so
		// refuse rather than write markers into the host at the wrong place.
		if (section.sourcePath !== view.file?.path) {
			new Notice("Can only comment on this note's own text, not embedded content.");
			return;
		}
		const data = view.getViewData();
		const sourceSelection = mapReadingSelection(selection, section, data);
		if (!sourceSelection) {
			new Notice("Couldn't map the selection to the Markdown — try plain text without formatting.");
			return;
		}
		const { from, to, expected } = sourceSelection;
		const targetHighlightId = findHighlightAtSelection(data, from, to)?.id;
		const emptyAction = targetHighlightId ? "remove" : this.settings.allowEmptyComments ? "highlight" : "none";
		if (Platform.isMobile) {
			// No margin composer on mobile — write straight to the file from a modal,
			// then refresh so the new highlight appears in the reading view.
			const file = view.file;
			if (!file) {
				new Notice("No file is open.");
				return;
			}
			new CommentModal(
				this.app,
				selected,
				(text) => this.insertReadingComment(file, from, to, text, expected, targetHighlightId),
				emptyAction,
			).open();
			return;
		}
		// Same inline draft composer as the editor (no modal).
		this.readingManager?.startDraft(
			view,
			from,
			to,
			selection.getRangeAt(0),
			expected,
			emptyAction,
			targetHighlightId,
		);
	}

	/** Mobile reading-view create: write to the file (no editor surface) and refresh.
	 *  insertCommentInFile already folds I/O + compute failures into the Result. */
	private async insertReadingComment(
		file: TFile,
		from: number,
		to: number,
		text: string,
		expected: string,
		targetHighlightId?: string,
	): Promise<Result<void, string>> {
		const result = await insertCommentInFile(
			this.app,
			file,
			from,
			to,
			text,
			this.authorName(),
			expected,
			this.settings.allowEmptyComments,
			targetHighlightId,
		);
		result.match({
			ok: () => this.scheduleReadingRefresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
		return result.map(() => undefined);
	}

	private async toggleComments(): Promise<void> {
		const previous = this.settings.showComments;
		this.settings.showComments = !previous;
		const saved = await this.saveSettings();
		if (saved.isErr()) {
			this.settings.showComments = previous;
			new Notice(`Couldn't save settings: ${saved.error}`);
			return;
		}
		this.updateRibbon();
		this.refreshEditors();
		new Notice(this.settings.showComments ? "Comments shown" : "Comments hidden");
	}

	private async toggleResolved(): Promise<void> {
		const previous = this.settings.showResolved;
		this.settings.showResolved = !previous;
		const saved = await this.saveSettings();
		if (saved.isErr()) {
			this.settings.showResolved = previous;
			new Notice(`Couldn't save settings: ${saved.error}`);
			return;
		}
		this.refreshEditors();
		new Notice(this.settings.showResolved ? "Resolved comments shown" : "Resolved comments hidden");
	}

	updateRibbon(): void {
		if (!this.ribbonIcon) return;
		this.ribbonIcon.toggleClass("is-active", this.settings.showComments);
		this.ribbonIcon.setAttribute(
			"aria-label",
			this.settings.showComments ? "Hide document comments" : "Show document comments",
		);
	}

	/** Force open editors + reading views (+ the sidebar) to re-evaluate live config. */
	refreshEditors(): void {
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf: WorkspaceLeaf) => {
			editorViewFromLeaf(leaf)?.dispatch({ effects: refreshCommentColors.of(null) });
			const readingView = leaf.view.containerEl.querySelector(".markdown-reading-view");
			if (!isHtmlElement(readingView)) return;
			const draftColor = authorColorCss(this.highlightColorForAuthor(this.authorName()));
			readingView.style.setProperty("--dc-highlight-color", draftColor);
			readingView.style.setProperty("--dc-draft-highlight-color", draftColor);
			readingView.querySelectorAll<HTMLElement>(".doc-comment-span[data-dc-author]").forEach((span) => {
				const author = span.dataset.dcAuthor;
				if (author) {
					span.style.setProperty(
						"--dc-highlight-color",
						authorColorCss(this.highlightColorForAuthor(author)),
					);
				}
			});
		});
		this.scheduleReadingRefresh();
		this.sidebarView()?.requestRefresh();
	}

	/** Reveal the comments sidebar panel, creating it in the right split if needed. */
	private async activateSidebar(): Promise<void> {
		const { workspace } = this.app;
		const opened = await Result.tryPromise({
			try: async () => {
				let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0] ?? null;
				if (!leaf) {
					leaf = workspace.getRightLeaf(false);
					if (!leaf) return;
					await leaf.setViewState({ type: COMMENTS_VIEW_TYPE, active: true });
				}
				// A sidebar leaf restored from the workspace but never revealed is a
				// DeferredView (Obsidian ≥1.7) — its view isn't a CommentsSidebarView yet,
				// so revealComment/refresh would silently no-op. Force it to load first.
				if (leaf.isDeferred) await leaf.loadIfDeferred();
				await workspace.revealLeaf(leaf);
				this.syncSidebarOpen();
			},
			catch: (e) => (e instanceof Error ? e.message : "unknown error"),
		});
		if (opened.isErr()) new Notice(`Couldn't open the comments sidebar: ${opened.error}`);
	}

	/** Open the sidebar and scroll it to a thread — the escape from a margin card too
	 *  tall to fit the column even when expanded. */
	private async revealComment(id: string): Promise<void> {
		await this.activateSidebar();
		await this.sidebarView()?.revealComment(id);
	}

	/** The live sidebar view instance, if the panel is open. */
	private sidebarView(): CommentsSidebarView | null {
		const leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0];
		return leaf?.view instanceof CommentsSidebarView ? leaf.view : null;
	}

	/** Recompute whether the comments panel is actually visible and, when that
	 *  changes, refresh editors so the inline column steps aside / comes back.
	 *  Visibility — not mere existence — is what matters: a collapsed dock or a
	 *  hidden tab must bring the inline cards back. */
	private syncSidebarOpen(): void {
		const open = this.isSidebarVisible();
		if (open === this.sidebarOpen) return;
		this.sidebarOpen = open;
		this.refreshEditors();
	}

	private isSidebarVisible(): boolean {
		const { workspace } = this.app;
		return workspace.getLeavesOfType(COMMENTS_VIEW_TYPE).some((leaf) => {
			// A collapsed dock flips `.collapsed` immediately; the DOM width animates,
			// so an offsetParent/size check alone lags a frame and misses the change.
			const root = leaf.getRoot();
			if (root === workspace.leftSplit && workspace.leftSplit.collapsed) return false;
			if (root === workspace.rightSplit && workspace.rightSplit.collapsed) return false;
			// Not in a collapsed dock — visible unless it's a hidden background tab.
			return leaf.view.containerEl.offsetParent !== null;
		});
	}

	onunload(): void {
		this.readingManager?.destroy();
		this.unsubscribeAuthorIndex?.();
		this.authorIndex?.dispose();
	}

	private authorName(): string {
		return this.settings.author.trim() || "me";
	}

	colorForAuthor(author: string): ResolvedAuthorColor {
		const key = canonicalAuthorKey(author) || canonicalAuthorKey(this.authorName());
		const resolved = resolveAuthorColor(
			this.settings.authorColors,
			this.excludedAuthorColorSet,
			key,
			this.settings.authorColorsEnabled,
		);
		if (resolved.created) this.scheduleAuthorColorSave();
		return resolved.color;
	}

	highlightColorForAuthor(author: string): ResolvedAuthorColor {
		return effectiveHighlightColor(this.colorForAuthor(author), this.settings.authorColorsEnabled);
	}

	ensureCurrentAuthorColor(): void {
		this.colorForAuthor(this.authorName());
	}

	async setAuthorColor(author: string, value: unknown): Promise<void> {
		const parsed = parseHexColor(value);
		if (parsed.isErr()) {
			this.settingsPersistenceError = `Couldn't save ${author}'s color: ${parsed.error}`;
			this.settingsTab?.refresh();
			return;
		}
		const key = canonicalAuthorKey(author);
		const previous = this.captureAuthorColorState(key);
		this.removeAuthorColorExclusion(key);
		this.settings.authorColors[key] = { color: parsed.value, mode: "custom" };
		const saved = await this.persistAuthorColors();
		if (saved.isErr()) this.restoreAuthorColorState(key, previous);
		this.refreshEditors();
		this.settingsTab?.refresh();
	}

	async deleteAuthorColor(author: string): Promise<void> {
		const key = canonicalAuthorKey(author);
		if (!key) return;
		const previous = this.captureAuthorColorState(key);
		delete this.settings.authorColors[key];
		this.excludedAuthorColorSet.add(key);
		this.syncExcludedAuthorColors();
		const saved = await this.persistAuthorColors();
		if (saved.isErr()) this.restoreAuthorColorState(key, previous);
		this.refreshEditors();
		this.settingsTab?.refresh();
	}

	async restoreAuthorColor(author: string): Promise<void> {
		const key = canonicalAuthorKey(author);
		if (!key) return;
		const previous = this.captureAuthorColorState(key);
		this.removeAuthorColorExclusion(key);
		ensureAuthorColor(this.settings.authorColors, key);
		const saved = await this.persistAuthorColors();
		if (saved.isErr()) this.restoreAuthorColorState(key, previous);
		this.refreshEditors();
		this.settingsTab?.refresh();
	}

	async rescanAuthors(): Promise<void> {
		const scanned = await Result.tryPromise({
			try: async () => this.authorIndex?.scan(),
			catch: (error) => (error instanceof Error ? error.message : "Unknown vault scan error"),
		});
		this.authorIndexError = scanned.isErr() ? `Couldn't scan highlight creators: ${scanned.error}` : null;
		this.settingsTab?.refresh();
	}

	async scanAuthorsIfEnabled(): Promise<void> {
		if (!this.settings.authorColorsEnabled) return;
		await this.rescanAuthors();
	}

	authorColorView(): {
		state: AuthorIndexState;
		active: string[];
		missing: string[];
		uncolored: string[];
		saveError: string | null;
	} {
		const state = this.authorIndex?.getState() ?? { status: "idle", authors: [] };
		const discovered = [...new Set([...state.authors, canonicalAuthorKey(this.authorName())])].sort((a, b) =>
			a.localeCompare(b),
		);
		const discoveredSet = new Set(discovered);
		const active = discovered.filter((author) => this.settings.authorColors[author] !== undefined);
		const missing = Object.keys(this.settings.authorColors)
			.filter((author) => !discoveredSet.has(author))
			.sort((a, b) => a.localeCompare(b));
		const uncolored = [...this.excludedAuthorColorSet].sort((a, b) => a.localeCompare(b));
		return { state, active, missing, uncolored, saveError: this.settingsPersistenceError ?? this.authorIndexError };
	}

	private handleAuthorIndexState(state: AuthorIndexState): void {
		const created = ensureAuthorColors(this.settings.authorColors, state.authors, this.excludedAuthorColorSet);
		if (created) this.scheduleAuthorColorSave();
		this.settingsTab?.refresh();
		this.refreshEditors();
	}

	private async writeSettings(errorPrefix: string): Promise<Result<void, string>> {
		const saved = await saveSettingsData((data) => this.saveData(data), this.settings);
		this.settingsPersistenceError = saved.isErr() ? `${errorPrefix}: ${saved.error.message}` : null;
		this.settingsTab?.refresh();
		return saved.mapError((error) => error.message);
	}

	private async persistAuthorColors(): Promise<Result<void, string>> {
		return this.writeSettings("Couldn't persist highlight colors");
	}

	async loadSettings(): Promise<void> {
		const loaded = await loadSettingsData(() => this.loadData());
		this.settingsPersistenceError = loaded.isErr() ? `Couldn't load settings: ${loaded.error.message}` : null;
		const rawData = loaded.isOk() ? loaded.value : null;
		const data = rawData && typeof rawData === "object" ? (rawData as Partial<DocCommentsSettings>) : {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data, {
			authorColors: hydrateAuthorColors(data.authorColors),
			excludedAuthorColors: hydrateExcludedAuthors(data.excludedAuthorColors),
		});
		this.excludedAuthorColorSet = new Set(this.settings.excludedAuthorColors);
		const resolved = resolveAuthorColor(
			this.settings.authorColors,
			this.excludedAuthorColorSet,
			this.authorName(),
			this.settings.authorColorsEnabled,
		);
		if (loaded.isOk() && resolved.created) await this.persistAuthorColors();
	}

	private removeAuthorColorExclusion(author: string): void {
		if (!this.excludedAuthorColorSet.delete(author)) return;
		this.syncExcludedAuthorColors();
	}

	private syncExcludedAuthorColors(): void {
		this.settings.excludedAuthorColors = [...this.excludedAuthorColorSet].sort((a, b) => a.localeCompare(b));
	}

	private captureAuthorColorState(author: string): AuthorColorStateSnapshot {
		return {
			assignment: this.settings.authorColors[author],
			excluded: this.excludedAuthorColorSet.has(author),
		};
	}

	private restoreAuthorColorState(author: string, snapshot: AuthorColorStateSnapshot): void {
		if (snapshot.assignment) this.settings.authorColors[author] = snapshot.assignment;
		else delete this.settings.authorColors[author];
		if (snapshot.excluded) this.excludedAuthorColorSet.add(author);
		else this.excludedAuthorColorSet.delete(author);
		this.syncExcludedAuthorColors();
	}

	settingsError(): string | null {
		return this.settingsPersistenceError;
	}

	async saveSettings(): Promise<Result<void, string>> {
		return this.writeSettings("Couldn't save settings");
	}
}

const editorView = (editor: Editor): EditorView | null => {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
};

const editorViewFromLeaf = (leaf: WorkspaceLeaf): EditorView | null => {
	return leaf.view instanceof MarkdownView ? editorView(leaf.view.editor) : null;
};
