# Changelog

All notable changes to **Document Comments**. The release workflow uses the section
matching the pushed tag as that GitHub release's notes, so add an entry here before tagging.

## 0.1.6
- Fixed the inline comment column continuing to reserve its ~320px of margin over empty space once every comment on a note was resolved (with "Show resolved" off). The column is now reserved only when a comment's card actually renders, in both Live Preview and Reading view ([#30](https://github.com/kylemcd/obsidian-document-comments/issues/30)).
- Updated development dependencies (oxlint, eslint, typescript-eslint, @types/node, @codemirror/view).

## 0.1.5
- Fixed the document reflowing (shifting left, then re-centering) every time you started or finished a comment. The new-comment composer is a floating overlay and no longer reserves the margin column, so the text stays put — most noticeable when the comments sidebar is open and the inline column isn't shown ([#15](https://github.com/kylemcd/obsidian-document-comments/issues/15)).

## 0.1.4
- **Mobile support** — Document Comments now works on Obsidian mobile. There's no floating margin on phones and tablets; instead the in-text highlights mark commented text and you read, reply, and resolve through the **"All discussions" sidebar**, with new comments composed in a quick dialog. It's the same inline storage, so a note's comments are identical across desktop and mobile.
- Saving a comment now reports a clear reason if it ever fails, instead of occasionally failing silently.

## 0.1.3
- Sidebar: the last comment's reply field is no longer cut off at the bottom — there's room to scroll it up clear of the status bar, with space to grow as you type.

## 0.1.2
- **Markdown in comments** — comment text now renders Markdown (code spans, bold, links, lists) in both the margin and the sidebar.
- **Long comments** collapse to a "Show more" preview; one click opens the full thread *and* the reply box. A thread taller than the screen shows "Open in sidebar" instead (its bottom is unreachable inline).
- **Margin polish** — cards slide off the top edge as you scroll instead of sticking; clicking a card no longer scrolls the document; the reply box reveals and focuses when you open a card; expand/collapse animates smoothly.
- Comment highlights now render inside **tables** in Reading view. (Live Preview can't highlight inside its table widget — a documented limitation.)

## 0.1.1
- Addressed Obsidian community-plugin review feedback.
- Removed every `:has()` and `!important` from the stylesheet (selectors are now scoped to out-specify Obsidian's core rules).
- Replaced the `builtin-modules` build dependency with `node:module`.
- Added a CI release workflow that builds the plugin and attaches **build-provenance attestations** to the release assets.

## 0.1.0
- Initial release — Notion/Linear-style margin comments stored inline in your markdown as HTML comments, with threads, reactions, resolve/reopen, a comments sidebar, and Reading-view support.
