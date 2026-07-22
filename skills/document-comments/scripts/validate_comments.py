#!/usr/bin/env python3
"""Validate Document Comments markers in a Markdown file.

Applies the same rules the plugin's parser uses, and flags the ways comments
silently break — the most common being an ID with a character outside
[A-Za-z0-9] (e.g. a hyphen), which makes the parser discard the marker.

Usage:
    python3 validate_comments.py FILE.md [FILE.md ...]

Exit status is non-zero if any definite problem is found (invalid ID, a
marker with no body, or a duplicated ID), so it can gate an agent's work.
No third-party dependencies — Python 3 standard library only.
"""

import re
import sys

VALID_ID = re.compile(r"^[A-Za-z0-9]+$")
# Loose scans: capture whatever the author actually wrote as the id token, so we
# can tell a valid marker from a malformed one the strict parser would ignore.
OPEN_LOOSE = re.compile(r"<!--c:([^\s>]*)-->")
CLOSE_LOOSE = re.compile(r"<!--/c:([^\s>]*)-->")
BODY_LOOSE = re.compile(r"<!--co:([^\s]*)([^\n]*)\n?([\s\S]*?)-->")


def masked_spans(doc):
    """Character ranges to ignore: fenced code blocks and inline code spans."""
    spans = []
    offset = 0
    fence_start = -1
    fence_char = ""
    for line in doc.split("\n"):
        line_end = offset + len(line)
        m = re.match(r"[ \t]*(`{3,}|~{3,})", line)
        if fence_start < 0 and m:
            fence_start, fence_char = offset, m.group(1)[0]
        elif fence_start >= 0 and m and m.group(1)[0] == fence_char:
            spans.append((fence_start, line_end))
            fence_start = -1
        offset = line_end + 1
    if fence_start >= 0:
        spans.append((fence_start, len(doc)))
    for m in re.finditer(r"`+[^`\n]*`+", doc):
        spans.append((m.start(), m.end()))
    return spans


def is_masked(spans, index):
    return any(a <= index < b for a, b in spans)


def status_of(header):
    m = re.search(r"status:(\S+)", header)
    return "resolved" if (m and m.group(1) == "resolved") else "open"


def quote_of(header):
    m = re.search(r'quote:"([^"]*)"', header)
    return m.group(1) if m else ""


def analyze(doc):
    spans = masked_spans(doc)
    opens, closes, bodies, problems = {}, {}, {}, []

    def scan(rx, kind):
        for m in rx.finditer(doc):
            if is_masked(spans, m.start()):
                continue
            raw = m.group(1)
            if not VALID_ID.match(raw):
                problems.append(
                    (kind, raw, m.group(0)[:40])
                )
                continue
            yield raw, m

    for rid, m in scan(OPEN_LOOSE, "open"):
        opens.setdefault(rid, m.start())
    for rid, m in scan(CLOSE_LOOSE, "close"):
        closes.setdefault(rid, m.start())
    for rid, m in scan(BODY_LOOSE, "body"):
        bodies.setdefault(rid, (m.group(2) or "", m.start()))

    ids = []
    for i in list(opens) + list(closes) + list(bodies):
        if i not in ids:
            ids.append(i)

    comments = []
    for cid in ids:
        has_open, has_close = cid in opens, cid in closes
        has_body = cid in bodies
        anchored = has_open and has_close and opens[cid] <= closes[cid]
        if anchored and has_body:
            state = "ANCHORED"
        elif has_body:
            state = "ORPHAN"
        else:
            state = "MARKERS-ONLY"
        header = bodies[cid][0] if has_body else ""
        comments.append(
            {
                "id": cid,
                "state": state,
                "status": status_of(header) if has_body else "-",
                "quote": quote_of(header),
            }
        )
    return comments, problems


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    any_problem = False
    for path in argv[1:]:
        try:
            with open(path, encoding="utf-8") as fh:
                doc = fh.read()
        except OSError as err:
            print(f"{path}: cannot read ({err})")
            any_problem = True
            continue

        comments, problems = analyze(doc)
        print(f"\n{path} — {len(comments)} comment(s)")
        for c in comments:
            note = ""
            if c["state"] == "ORPHAN":
                note = "  (body has no valid anchor — the commented text was likely edited away)"
            elif c["state"] == "MARKERS-ONLY":
                note = "  (anchor markers but no body block)"
            quote = f'  "{c["quote"]}"' if c["quote"] else ""
            print(f"  {c['state']:<13} {c['id']:<10} status:{c['status']:<9}{quote}{note}")

        for kind, raw, snippet in problems:
            any_problem = True
            print(
                f"  INVALID ID   in {kind} marker: {snippet!r} — "
                f'id "{raw}" has characters outside [A-Za-z0-9]; the parser ignores this marker'
            )

        marker_only = [c for c in comments if c["state"] == "MARKERS-ONLY"]
        orphans = [c for c in comments if c["state"] == "ORPHAN"]
        if marker_only:
            any_problem = True
        if orphans:
            print(f"  note: {len(orphans)} orphan(s) — fine if the text was intentionally removed, else a broken comment")

    print()
    if any_problem:
        print("PROBLEMS FOUND — fix the flagged markers above.")
        return 1
    print("OK — all comments are well-formed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
