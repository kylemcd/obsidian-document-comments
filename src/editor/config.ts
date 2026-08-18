import { Facet } from "@codemirror/state";
import type { App } from "obsidian";
import type { AuthorColorResolver } from "../author-colors";

export type CommentConfig = {
	/** App handle, so the inline margin can render comment text as Markdown. */
	app?: App;
	/** Render an anchor's Markdown to detached DOM so Live Preview table
	 *  highlights can match the text Obsidian actually displays. */
	renderMarkdown?: (markdown: string, el: HTMLElement) => Promise<void>;
	/** Current author handle, read live so settings changes take effect. */
	author: () => string;
	/** Resolve and, when necessary, persist an original creator's highlight color. */
	colorForAuthor: AuthorColorResolver;
	/** Resolve the color painted in the document. This differs from author-name
	 *  colors when the global toggle restores the legacy yellow highlight. */
	highlightColorForAuthor?: AuthorColorResolver;
	/** Whether the margin column is shown at all (Notion-style toggle). */
	showComments: () => boolean;
	/** Whether resolved comments still show a card in the margin. */
	showResolved: () => boolean;
	/** Whether the new-comment composer accepts an empty comment. */
	allowEmptyComments: () => boolean;
	/** Whether the comments sidebar panel is open. While it is, the inline
	 *  floating cards step aside (comments live in the panel) but the in-text
	 *  highlights stay. */
	sidebarOpen: () => boolean;
	/** Reveal a thread in the sidebar — used by a margin card too tall to fit. */
	openInSidebar?: (id: string) => void;
	/** True on Obsidian mobile. The floating margin column needs horizontal room
	 *  mobile doesn't have, so there it's suppressed (text stays full-width) and
	 *  comments live in the sidebar panel instead; the in-text highlights remain. */
	isMobile?: () => boolean;
};

const DEFAULT: CommentConfig = {
	author: () => "me",
	colorForAuthor: () => null,
	showComments: () => true,
	showResolved: () => true,
	allowEmptyComments: () => false,
	sidebarOpen: () => false,
};

export const commentConfig = Facet.define<CommentConfig, CommentConfig>({
	combine: (values) => ({ ...DEFAULT, ...values[0] }),
});
