---
name: document-comments
description: >-
  Read, add, reply to, resolve, or delete inline comments stored directly in a
  Markdown file using the Document Comments format — invisible HTML-comment
  anchor markers (`<!--c:ID-->…<!--/c:ID-->`) around the commented text plus a
  matching `<!--co:ID …-->` body block holding the thread. Use this whenever a
  user asks to leave or add a comment on a passage of a Markdown document, reply
  to or resolve existing comments, or audit/clean up comments — and whenever you
  see `<!--c:…-->`, `<!--/c:…-->`, or `<!--co:…-->` markers in a `.md` file and
  need to read or edit them. The marker syntax and IDs must be exact: a malformed
  comment silently fails to render, so consult this skill instead of guessing.
---

# Document Comments

This format stores Google-Docs-style inline comments **inside** a Markdown file,
using HTML comments so they stay invisible in every renderer (Obsidian, GitHub,
Pandoc) and survive edits. A companion editor plugin turns them into highlights
and margin cards, but the file is the source of truth — every operation here is a
plain text edit, and anyone (human, agent, or the plugin) reads and writes the
same syntax.

Your job when this skill triggers: read or modify these comments **without
breaking the syntax**. Malformed comments do not error — they silently fail to
render, leak their raw text into the document, or attach to the wrong place. The
rules below exist to prevent exactly that.

## Anatomy of a comment

A single comment is three pieces sharing one **ID**:

```markdown
We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless of the timeline.

<!--co:k3f9 by:alice at:2026-01-15T10:00:00.000Z status:open quote:"ship on Friday"
alice (2026-01-15T10:00:00.000Z): Are we sure QA has time?
bob (2026-01-15T11:00:00.000Z): They confirmed Thursday.
-->
```

- **Anchor open** `<!--c:ID-->` sits immediately **before** the commented text.
- **Anchor close** `<!--/c:ID-->` sits immediately **after** it. The text between
  the two markers is what gets highlighted.
- **Body block** `<!--co:ID …-->` holds the metadata and the thread. It goes on
  the line(s) right after the block (paragraph, heading, list item) that contains
  the anchor.

All three use the **same ID**. That is how they are linked.

## The ID rule (the most common way to break a comment)

An ID must match `[A-Za-z0-9]+` — **ASCII letters and digits only**. No hyphens,
underscores, spaces, dots, or other punctuation.

This is the single most important rule, because a bad ID fails quietly and in a
confusing way. If you write `<!--c:my-comment-->`, the parser reads the ID as
`my` and then expects `-->`, finds `-comment-->` instead, and **discards the
whole marker**. The anchor vanishes, the text stops being highlighted, and the
raw `<!--c:my-comment-->` shows up in the document. The body block, meanwhile,
parses under a truncated ID (`my`) and becomes an orphan. Everything looks
plausible and nothing works.

Generate IDs the way the plugin does: **4–6 random lowercase alphanumeric
characters** (e.g. `k3f9`, `a7b2`, `zq08`). Before using one, scan the file for
existing `<!--c:` / `<!--co:` markers and pick an ID that is not already taken —
IDs must be unique within a file.

## Adding a comment

1. **Find the exact text to anchor.** Pick a specific, contiguous run of text on
   a single block. Shorter and unique is better (it re-anchors more reliably).
2. **Generate a fresh ID** (see the ID rule) and confirm it's unused in the file.
3. **Wrap the text** with `<!--c:ID-->` before and `<!--/c:ID-->` after — with no
   space introduced between the markers and the text.
4. **Append the body block** on the line immediately after the block that
   contains the anchor:

   ```
   <!--co:ID by:AUTHOR at:TIMESTAMP status:open quote:"ANCHORED TEXT"
   AUTHOR (TIMESTAMP): your comment text
   -->
   ```

   - `by:` the author handle (single token — replace spaces with `_`). Optional
     but recommended.
   - `at:` an ISO-8601 timestamp for creation. Optional; include it if you know
     the current time.
   - `status:open` for a new comment.
   - `quote:"…"` a copy of the anchored text in double quotes. This is the
     re-anchor fallback if the markers are ever lost, so it should match the
     text between the markers. Collapse internal whitespace to single spaces.
   - The thread: one entry per line, the first line being the original comment.

**Worked example.** To comment "this needs a source" on the phrase `net zero by
2030` in the paragraph:

> Our roadmap commits us to net zero by 2030 across all operations.

Result:

```markdown
Our roadmap commits us to <!--c:q4m2-->net zero by 2030<!--/c:q4m2--> across all operations.
<!--co:q4m2 by:agent at:2026-01-15T14:30:00.000Z status:open quote:"net zero by 2030"
agent (2026-01-15T14:30:00.000Z): this needs a source
-->
```

## Replying, resolving, and deleting

These all edit the **body block**; the anchor markers stay put.

- **Reply**: add a new thread line **before** the closing `-->`, in the same
  `author (timestamp): text` shape. Leave the header and existing lines alone.
- **Resolve / reopen**: change `status:open` to `status:resolved` (or back) in the
  header. Nothing else changes.
- **Edit a reply**: change the text after the `:` on that thread line only.
- **Delete a comment**: remove all three pieces — the `<!--c:ID-->` marker, the
  `<!--/c:ID-->` marker, and the entire `<!--co:ID …-->` body block — leaving the
  anchored text itself in place.

## Reading comments

To answer questions about existing comments, scan for `<!--co:ID …-->` blocks.
Each block's header gives the author/time/status, the `quote:` (or the text
between that ID's markers) tells you what it's attached to, and the lines after
the header are the thread. A body whose ID has no matching `<!--c:ID-->` /
`<!--/c:ID-->` pair is an **orphan** — its anchored text was edited away.

## Pitfalls that silently break comments

- **Bad IDs** — covered above. This is the big one.
- **The sequence `-->` inside a comment.** A literal `-->` anywhere in the body
  (or in a `quote:`) ends the HTML comment early, dumping the rest of the thread
  into the visible document. If the text you're storing contains `-->`, break it
  with a zero-width space (`--​>`) so it reads the same but no longer
  terminates the comment.
- **Multi-line thread text.** Each thread entry is one physical line. A raw
  newline inside a reply starts what looks like a new entry. Keep replies to a
  single line, or see `references/format-reference.md` for the escaping scheme.
- **Commenting inside a fenced code block.** Markers placed inside a ```` ``` ````
  fence render as literal text and are ignored by the parser. Commenting on code
  needs a different (whole-block) anchoring approach — see the reference.
- **Mismatched or missing markers.** An `<!--c:ID-->` with no matching
  `<!--/c:ID-->` (or vice versa) is not a valid anchor. Always write the pair.

## Verify your work

After adding or editing comments, **validate the file** with the bundled script,
which reports each comment's status and flags anything malformed:

```bash
python3 skills/document-comments/scripts/validate_comments.py path/to/file.md
```

Every comment you created or touched should report `ANCHORED` (or `resolved`).
An `ORPHAN`, `MARKERS-ONLY`, or `INVALID ID` line means a comment is broken —
fix it before finishing. This catches the quiet failures the format is prone to.

## Full reference

`references/format-reference.md` documents the complete on-disk format: every
header key, the thread and reaction line grammar, multi-line/`-->` escaping, code
comments, ordering and uniqueness rules, and the parser's exact behavior. Read it
when you need an edge case beyond the common create/reply/resolve/delete flow.
