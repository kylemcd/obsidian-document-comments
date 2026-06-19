import { Facet } from "@codemirror/state";
import type { App } from "obsidian";

export type CommentConfig = {
	/** App handle, so the inline margin can render comment text as Markdown. */
	app?: App;
	/** Current author handle, read live so settings changes take effect. */
	author: () => string;
	/** Whether the margin column is shown at all (Notion-style toggle). */
	showComments: () => boolean;
	/** Whether resolved comments still show a card in the margin. */
	showResolved: () => boolean;
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
	showComments: () => true,
	showResolved: () => true,
	sidebarOpen: () => false,
};

export const commentConfig = Facet.define<CommentConfig, CommentConfig>({
	combine: (values) => values[0] ?? DEFAULT,
});
