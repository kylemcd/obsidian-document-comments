import {
	Component,
	Editor,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TFile,
	WorkspaceLeaf,
	debounce,
} from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { commentField } from "./editor/state";
import { marginPlugin } from "./editor/margin";
import { commentConfig } from "./editor/config";
import { editorLayoutField } from "./editor/layout";
import { draftField, setDraft } from "./editor/draft";
import { addComment, insertCommentInFile } from "./editor/commands";
import { findSectionRange, highlightPostProcessor } from "./reading/highlight";
import { ReadingDeps, ReadingMarginManager } from "./reading/margin";
import { COMMENTS_VIEW_TYPE, CommentsSidebarView, SidebarDeps } from "./ui/sidebar";
import { CommentModal } from "./ui/comment-modal";
import { DEFAULT_SETTINGS, DocCommentsSettings, DocCommentsSettingTab } from "./settings";
import { tableHighlightPlugin } from "./editor/table-highlights";

export default class DocCommentsPlugin extends Plugin {
	settings: DocCommentsSettings = { ...DEFAULT_SETTINGS };
	private markdown = new Component();
	private ribbonIcon: HTMLElement | null = null;
	private readingManager: ReadingMarginManager | null = null;
	private scheduleReadingRefresh: () => void = () => {};
	/** True while the "All discussions" sidebar panel is mounted. */
	private sidebarOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addChild(this.markdown);

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
				showComments: () => this.settings.showComments,
				showResolved: () => this.settings.showResolved,
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
			showComments: () => this.settings.showComments,
			showResolved: () => this.settings.showResolved,
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
		};
		this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsSidebarView(leaf, sidebarDeps));

		this.registerMarkdownPostProcessor((el, ctx) => {
			highlightPostProcessor(el, ctx);
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
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleReadingRefresh()));

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

		this.addSettingTab(new DocCommentsSettingTab(this.app, this));
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
		if (Platform.isMobile) {
			// No floating margin composer on mobile — collect the text in a modal,
			// then write through the same editor path so it's a single undo step.
			const quote = view.state.doc.sliceString(from, to);
			new CommentModal(this.app, quote, (text) => {
				const result = addComment(view, from, to, text, this.authorName());
				if (result.isErr()) new Notice(`Couldn't add the comment: ${result.error}`);
			}).open();
			return;
		}
		// Show a draft composer card in the margin (Notion-style) instead of a modal.
		view.dispatch({ effects: setDraft.of({ from, to }) });
	}

	/** Reading view has no editor surface, so map the rendered selection back to
	 *  source offsets (best-effort) and prompt for the comment text. */
	private startAddCommentReading(view: MarkdownView): void {
		const selection = activeWindow.getSelection();
		const selected = selection?.toString().trim() ?? "";
		if (!selection || selection.rangeCount === 0 || !selected) {
			new Notice("Select some text to comment on.");
			return;
		}
		const section = selection.anchorNode ? findSectionRange(selection.anchorNode) : null;
		if (!section) {
			new Notice("Couldn't locate that selection in the note.");
			return;
		}
		const idx = section.source.indexOf(selected);
		if (idx < 0) {
			new Notice("Couldn't map the selection to the Markdown — try plain text without formatting.");
			return;
		}
		const from = section.from + idx;
		const to = from + selected.length;
		if (Platform.isMobile) {
			// No margin composer on mobile — write straight to the file from a modal,
			// then refresh so the new highlight appears in the reading view.
			const file = view.file;
			if (!file) {
				new Notice("No file is open.");
				return;
			}
			new CommentModal(this.app, selected, (text) => {
				void this.insertReadingComment(file, from, to, text);
			}).open();
			return;
		}
		// Same inline draft composer as the editor (no modal).
		this.readingManager?.startDraft(view, from, to, selection.getRangeAt(0));
	}

	/** Mobile reading-view create: write to the file (no editor surface) and refresh.
	 *  insertCommentInFile already folds I/O + compute failures into the Result. */
	private async insertReadingComment(file: TFile, from: number, to: number, text: string): Promise<void> {
		(await insertCommentInFile(this.app, file, from, to, text, this.authorName())).match({
			ok: () => this.scheduleReadingRefresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
	}

	private async toggleComments(): Promise<void> {
		this.settings.showComments = !this.settings.showComments;
		await this.saveSettings();
		this.updateRibbon();
		this.refreshEditors();
		new Notice(this.settings.showComments ? "Comments shown" : "Comments hidden");
	}

	private async toggleResolved(): Promise<void> {
		this.settings.showResolved = !this.settings.showResolved;
		await this.saveSettings();
		this.refreshEditors();
		new Notice(this.settings.showResolved ? "Resolved comments shown" : "Resolved comments hidden");
	}

	private updateRibbon(): void {
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
			editorViewFromLeaf(leaf)?.dispatch({});
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
	}

	private authorName(): string {
		return this.settings.author.trim() || "me";
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) as Partial<DocCommentsSettings> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

const editorView = (editor: Editor): EditorView | null => {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
};

const editorViewFromLeaf = (leaf: WorkspaceLeaf): EditorView | null => {
	return leaf.view instanceof MarkdownView ? editorView(leaf.view.editor) : null;
};
