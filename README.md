# Document Comments

Document Comments adds inline comments to Obsidian notes. It shows each comment as a card beside the text on desktop.

The plugin stores each comment inside its Markdown file as an HTML comment. Other editors, version control tools, and agents can read the comment.

[Install Document Comments from the Obsidian community plugin directory](https://community.obsidian.md/plugins/document-comments).

![Document Comments with threaded comment cards beside an Obsidian note](screenshot.png)

## Features

### Comments and storage

- Store comments inside Markdown files without a separate database.
- Add comments to prose, inline code, tables, and selected lines in fenced code blocks.
- Save selected text as a highlight without a comment.
- Reply, resolve, reopen, edit, delete, or react to a comment.
- Write Markdown in comments, including links, lists, bold text, and code spans.
- Use the same notes on desktop and mobile.

### Views and controls

- Show comment cards in Live Preview, Source view, and Reading view.
- Open long comments in the sidebar.
- Filter the sidebar by open, resolved, or all comments.
- Hide all comments or hide resolved comments.

## Comment format

The plugin uses an anchor pair and a comment block:

```markdown
We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless of the QA timeline.
<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"
kyle (2026-06-17T10:00:00.000Z): I thought we agreed Thursday?
sam (2026-06-17T10:05:00.000Z): Thursday is better for QA.
-->
```

The `<!--c:ID-->` and `<!--/c:ID-->` markers identify the selected text. The matching `<!--co:ID ...-->` block stores the comment thread.

Markdown renderers hide these HTML comments. Tools that read the source file can find each comment and its selected text.

Comments on fenced code blocks use the same format. The comment block also stores the selected line range and exact code text.

A highlight without a comment uses the same markers. Its comment block has no thread lines:

```markdown
We should <!--c:h7k2-->ship on Friday<!--/c:h7k2--> regardless of the QA timeline.
<!--co:h7k2 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"
-->
```

## Install

Document Comments requires Obsidian 1.7.2 or newer. It supports desktop and mobile.

### Community plugins

Use the [Document Comments plugin page](https://community.obsidian.md/plugins/document-comments), or install it from Obsidian:

1. Open **Settings → Community plugins**.
2. Select **Browse**.
3. Search for **Document Comments**.
4. Select **Install**.
5. Select **Enable**.

### BRAT

Use BRAT to install a pre-release build:

1. Install **BRAT** from Community plugins.
2. Enable **BRAT**.
3. Run **BRAT: Add a beta plugin for testing**.
4. Enter `kylemcd/obsidian-document-comments`.
5. Enable **Document Comments** in Community plugins.

BRAT installs the latest GitHub release and checks for updates.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/kylemcd/obsidian-document-comments/releases).
2. Copy the files to `<your-vault>/.obsidian/plugins/document-comments/`.
3. Restart or reload Obsidian.
4. Enable **Document Comments** in Community plugins.

Create the `document-comments` directory if it does not exist.

### Build from source

```bash
git clone https://github.com/kylemcd/obsidian-document-comments
cd obsidian-document-comments
npm install
npm run build
```

Copy or link `main.js`, `manifest.json`, and `styles.css` to `<your-vault>/.obsidian/plugins/document-comments/`.

Then enable **Document Comments** in Community plugins.

## Use the plugin

### Add a comment in an editing view

1. Select text or one or more lines in a fenced code block.
2. Run **Add comment** from the command palette or your configured editor menu.
3. Write the comment in the margin composer.
4. Press Enter to save the comment.

Press Shift+Enter to add a line break. On mobile, use the dialog to save the comment.

### Add a highlight without a comment

Document Comments disables empty comments by default.

1. Open **Settings → Document Comments**.
2. Enable **Allow empty comments**.
3. Select text and run **Add comment**.
4. Leave the comment field empty.
5. Press Enter on desktop, or select **Highlight** on mobile.

The plugin highlights the selected text without a comment card or sidebar entry.

To manage a highlight, select all its highlighted text and run **Add comment** again. Write text to convert it into a comment. Submit the empty field to remove the highlight.

When **Allow empty comments** is off, an empty field closes without a change.

### Add the command to the right-click menu

The optional [Commander plugin](https://community.obsidian.md/plugins/cmdr) can add commands to the editor menu.

#### Install Commander

1. Install **Commander**.
2. Enable **Commander**.

#### Configure the editor menu

1. Open **Settings → Commander**.
2. Select **Editor Menu**.
3. Select **Add command**.
4. Search for `Document Comments: Add comment`.
5. Select the command.
6. Choose an icon.

The command now appears at the bottom of the editor right-click menu. Select text before you use it.

### Add a comment in Reading view

1. Select text in the active note.
2. Run **Add comment in reading view**.
3. Write the comment.
4. Save the comment.

The Reading view command cannot add comments to embedded content.

### Manage a comment

Select a card to open its reply field. Hover over an entry to show its reaction, resolve, edit, and delete controls.

Use the **Open comments sidebar** command or ribbon icon to show all comments in the active note.

Use **Toggle comments** to show or hide all cards and highlights. Use **Toggle resolved comments** to show or hide resolved comments.

### Set the author

Open **Settings → Document Comments**. Set **Author** to the name that the plugin adds to new comments.

The plugin uses `me` when the Author setting is empty.

## Desktop and mobile behavior

Desktop views show cards in a margin beside the note. The cards align with their selected text and avoid overlaps.

Mobile views show the highlights without a margin. Use the sidebar to read and manage comments.

Mobile uses a dialog for new comments. The stored comment format stays the same on all devices.

## Agent support

This repository includes an agent skill for the Document Comments format:

```text
skills/document-comments/
```

The skill explains how to read and edit comments without damaging their markers. It also includes a validation script:

```bash
python3 skills/document-comments/scripts/validate_comments.py path/to/file.md
```

## Privacy

The plugin does not use the network, telemetry, or accounts. It stores all comment data in the note.

## Roadmap

Use the [Document Comments project](https://github.com/users/kylemcd/projects/1) to see the roadmap, current work, and planned work.

## Known limitations

- Reading view comments work best with plain text inside one paragraph.
- Reading view cannot add a comment to text inside an embed.
- Avoid overlapping comment anchors because comments on the same words can be difficult to manage.
- The sidebar shows an orphaned comment when no matching selected text remains.
- Live Preview table highlights require browser support for CSS Custom Highlight.

## Development

```bash
npm install
npm run dev
npm run build
npm run check
npm test
```

- `npm run dev` watches the source files and rebuilds `main.js`.
- `npm run build` checks types and creates a production bundle.
- `npm run check` checks formatting, lint rules, types, and tests.
- `npm test` runs the test suite.

### Release

Update `manifest.json`, `package.json`, `versions.json`, and `CHANGELOG.md` before a release.

Push a tag that exactly matches the version in `manifest.json`:

```bash
git tag 0.1.11
git push origin 0.1.11
```

The [release workflow](.github/workflows/release.yml) builds the plugin and publishes the GitHub release. It also creates attestations for the release files.

Verify a downloaded file with this command:

```bash
gh attestation verify main.js --repo kylemcd/obsidian-document-comments
```

## License

Document Comments uses the MIT License. See [LICENSE](LICENSE).
