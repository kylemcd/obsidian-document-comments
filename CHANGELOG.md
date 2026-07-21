# Changelog

All notable changes to **Document Comments**. The release workflow uses the section
matching the pushed tag as that GitHub release's notes, so add an entry here before tagging.

## 0.1.10
- Removed the `text-decoration-color` declarations that Obsidian's community-plugin review groups under the partially supported `text-decoration` browser feature. Open and resolved table comments remain visually distinct through their highlight backgrounds.

## 0.1.9
- Fixed an Obsidian community-plugin review compatibility warning by replacing the extended `text-decoration` shorthand in Live Preview table highlights with supported underline and color declarations. Table comment highlights remain visible in both open and resolved states.

## 0.1.8
- Fixed Live Preview table comments remaining unhighlighted until their cell was focused. Highlights now match Markdown-formatted anchors such as inline code and map mounted table widgets by source position, so they remain correct when CodeMirror virtualizes earlier tables.
- Kept hidden comment markers from appearing or wrapping text in focused table cells while preserving reliable cursor movement across marker boundaries.
- Fixed comments on inline code selections such as `` `Spinner` `` by placing the invisible anchor markers outside the backticks instead of rendering them as literal code.

## 0.1.7
- Added comment highlights inside Live Preview tables and hover previews for highlighted text. Highlights remain passive when clicked; selecting a comment in the sidebar now scrolls to its text reliably in either direction ([#29](https://github.com/kylemcd/obsidian-document-comments/issues/29)).
- Unified comment creation around the reliable **Add comment** selection command across regular text and tables, while retaining a separate Reading view command.
- Fixed the comment composer appearing behind table rows and other stacking problems in tables ([#28](https://github.com/kylemcd/obsidian-document-comments/issues/28)).
- Fixed cursor pauses and caret-height jumps around inline comment markers, including adjacent punctuation, line boundaries, nested markers, and deletion cases ([#41](https://github.com/kylemcd/obsidian-document-comments/issues/41)).
- Addressed Obsidian community-plugin review warnings by using supported DOM helpers and settings indexing patterns.
- Updated the release toolchain and development dependencies, including TypeScript 7, Vitest 4, typescript-eslint, eslint-plugin-obsidianmd, `@types/node`, and `actions/setup-node`; refreshed transitive dependencies with zero known audit vulnerabilities.

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
