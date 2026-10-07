import { describe, expect, test } from "vitest";
import { brokenLineAnchors, computeRepairLineAnchors } from "../src/editor/line-repair";
import { anchorDamage, computeRepairAnchors } from "../src/editor/anchor-repair";
import { applyChanges } from "../src/editor/edits";
import { parseComments } from "../src/format/parse";

const G = "\u200b";
const body = (id: string) => [`<!--co:${id} by:me status:open quote:"x"`, "me: hi", "-->"].join("\n");

const repair = (doc: string, only?: ReadonlySet<string>): string => {
	const result = computeRepairLineAnchors(doc, only);
	if (result.isErr()) throw new Error(result.error);
	return applyChanges(doc, result.value);
};

describe("brokenLineAnchors and its repair", () => {
	test.each([
		["a paragraph", "<!--c:aa11-->He<!--/c:aa11-->llo ==World==", `${G}<!--c:aa11-->He<!--/c:aa11-->llo ==World==`],
		[
			"a list item's text",
			"- <!--c:aa11-->Item<!--/c:aa11--> ==hl==",
			`- ${G}<!--c:aa11-->Item<!--/c:aa11--> ==hl==`,
		],
		["a quote's text", "> <!--c:aa11-->Quote<!--/c:aa11-->", `> ${G}<!--c:aa11-->Quote<!--/c:aa11-->`],
		[
			"a soft-wrapped line",
			"First line\n<!--c:aa11-->Second<!--/c:aa11--> line",
			`First line\n${G}<!--c:aa11-->Second<!--/c:aa11--> line`,
		],
		[
			"a closer starting a later line",
			"<!--c:aa11-->One\n<!--/c:aa11-->two",
			`${G}<!--c:aa11-->One\n${G}<!--/c:aa11-->two`,
		],
	])("guards a marker starting %s", (_label, line, fixed) => {
		const doc = `${line}\n${body("aa11")}`;

		expect([...brokenLineAnchors(doc)]).toEqual(["aa11"]);
		expect(repair(doc)).toBe(`${fixed}\n${body("aa11")}`);
	});

	test.each([
		["a bullet", "<!--c:aa11-->- Item<!--/c:aa11-->", `- ${G}<!--c:aa11-->Item<!--/c:aa11-->`],
		["a task box", "- <!--c:aa11-->[ ] Task<!--/c:aa11-->", `- [ ] ${G}<!--c:aa11-->Task<!--/c:aa11-->`],
		["a quote marker", "<!--c:aa11-->> Quote<!--/c:aa11-->", `> ${G}<!--c:aa11-->Quote<!--/c:aa11-->`],
		["a heading's #s", "<!--c:aa11-->## Heading<!--/c:aa11-->", `## <!--c:aa11-->Heading<!--/c:aa11-->`],
	])("moves an opener in front of %s past it, as a triple-click left it", (_label, line, fixed) => {
		const doc = `${line}\n${body("aa11")}`;

		expect([...brokenLineAnchors(doc)]).toEqual(["aa11"]);
		expect(repair(doc)).toBe(`${fixed}\n${body("aa11")}`);
	});

	test("brings a closer in front of a space back to the text it closes", () => {
		const doc = `<!--c:aa11-->One\n<!--/c:aa11--> two\n${body("aa11")}`;

		expect(repair(doc)).toBe(`${G}<!--c:aa11-->One<!--/c:aa11-->\n two\n${body("aa11")}`);
	});

	test("brings a closer in front of the next item's bullet back to the text it closes", () => {
		const doc = `<!--c:aa11-->- One\n<!--/c:aa11-->- Two\n${body("aa11")}`;

		expect(repair(doc)).toBe(`- ${G}<!--c:aa11-->One<!--/c:aa11-->\n- Two\n${body("aa11")}`);
	});

	test("moves a closer forward with the bullet when the line above ends a fence", () => {
		const doc = `<!--c:aa11-->Intro\n\`\`\`\ncode\n\`\`\`\n<!--/c:aa11-->- Next\n${body("aa11")}`;

		expect(repair(doc)).toContain(`\n\`\`\`\n- ${G}<!--/c:aa11-->Next\n`);
	});

	test("leaves a rule alone on a file with Windows line endings", () => {
		const doc = ["Intro <!--c:aa11-->text", "", "---", "<!--/c:aa11-->- Item", body("aa11"), ""].join("\r\n");

		expect(repair(doc)).not.toContain("---<!--/c:aa11-->");
		expect(repair(doc)).toContain("---\r\n- \u200b<!--/c:aa11-->Item");
	});

	test.each([
		[
			"the start of a rule",
			"Para text\n\n<!--c:aa11-->---\nNext text<!--/c:aa11-->",
			"Para text\n\n---\nG<!--c:aa11-->Next text<!--/c:aa11-->",
		],
		[
			"the end of a rule",
			"Para text\n\n---<!--c:aa11-->\nNext text<!--/c:aa11-->",
			"Para text\n\n---\nG<!--c:aa11-->Next text<!--/c:aa11-->",
		],
		[
			"a setext underline",
			"Intro <!--c:aa11-->Title text\n=====<!--/c:aa11-->",
			"Intro <!--c:aa11-->Title text<!--/c:aa11-->\n=====",
		],
	])("moves a marker off %s", (_label, line, fixed) => {
		const doc = `${line}\n${body("aa11")}`;

		expect([...brokenLineAnchors(doc)]).toEqual(["aa11"]);
		expect(repair(doc)).toBe(`${fixed.replace("G", G)}\n${body("aa11")}`);
	});

	test("leaves a marker after an empty bullet alone", () => {
		const doc = `- <!--c:aa11-->\n- Next<!--/c:aa11-->\n${body("aa11")}`;

		expect([...brokenLineAnchors(doc)]).toEqual([]);
	});

	test("guards a run once, in front of its first marker", () => {
		const doc = `<!--c:aa11--><!--c:bb22-->Hello<!--/c:bb22--><!--/c:aa11-->\n${body("aa11")}\n${body("bb22")}`;

		expect([...brokenLineAnchors(doc)].sort()).toEqual(["aa11", "bb22"]);
		expect(repair(doc).startsWith(`${G}<!--c:aa11--><!--c:bb22-->Hello`)).toBe(true);
	});

	test.each([
		["in the middle of a line", "Some <!--c:aa11-->text<!--/c:aa11-->"],
		["behind a guard", `${G}<!--c:aa11-->text<!--/c:aa11-->`],
		["starting a heading's text", "## <!--c:aa11-->Heading<!--/c:aa11-->"],
		["alone on its line", "<!--c:aa11-->\nText<!--/c:aa11-->"],
		["starting a table's body row", "a | b\n--|--\n<!--c:aa11-->c<!--/c:aa11--> | d"],
		["in front of a table row's pipe", "| A | B |\n| - | - |\n<!--c:aa11-->| 1 | 2 |<!--/c:aa11-->"],
		[
			"around a code block",
			`<!--c:aa11-->\n\`\`\`js\nx\n\`\`\`\n<!--/c:aa11-->\n<!--co:aa11 by:me status:open quote:"x" line:0\nme: hi\n-->`,
		],
	])("leaves a marker %s alone", (_label, doc) => {
		const withBody = doc.includes("<!--co:") ? doc : `${doc}\n${body("aa11")}`;

		expect([...brokenLineAnchors(withBody)]).toEqual([]);
		expect(repair(withBody)).toBe(withBody);
	});

	test("never moves an opener past its own closer", () => {
		const doc = `<!--c:aa11-->- <!--/c:aa11-->Item\n${body("aa11")}`;

		expect([...brokenLineAnchors(doc)]).toEqual([]);
	});

	test("finds nothing left to repair after a repair", () => {
		const doc = [
			"<!--c:aa11-->He<!--/c:aa11-->llo",
			"<!--c:bb22-->- One",
			"<!--/c:bb22-->- Two",
			"<!--c:cc33-->## Heading<!--/c:cc33-->",
			body("aa11"),
			body("bb22"),
			body("cc33"),
		].join("\n");
		const fixed = repair(doc);

		expect([...brokenLineAnchors(fixed)]).toEqual([]);
		expect(repair(fixed)).toBe(fixed);
	});

	test("limits the repair to the comments asked for", () => {
		const doc = [
			"<!--c:aa11-->One<!--/c:aa11-->",
			"",
			"<!--c:bb22-->Two<!--/c:bb22-->",
			body("aa11"),
			body("bb22"),
		].join("\n");

		expect(repair(doc, new Set(["bb22"]))).toBe(doc.replace("<!--c:bb22-->", `${G}<!--c:bb22-->`));
	});
});

describe("anchorDamage", () => {
	test("names a table broken by a marker as table damage, and a line as line damage", () => {
		const doc = [
			"<!--c:ln11-->Hello<!--/c:ln11--> there",
			"",
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:tb22-->| Monday | spec |<!--/c:tb22-->",
			"| Tuesday | review |",
			body("ln11"),
			body("tb22"),
		].join("\n");

		expect(Object.fromEntries(anchorDamage(doc))).toEqual({ ln11: "line", tb22: "table" });
		const result = computeRepairAnchors(doc);
		if (result.isErr()) throw new Error(result.error);
		const fixed = applyChanges(doc, result.value);
		expect(anchorDamage(fixed).size).toBe(0);
	});

	// Moving a closer back takes two edits, one at each end. A table repair that
	// touches one of them must hold back both, or the closer is deleted outright.
	test("never drops half of a closer's move when the table repair touches the other half", () => {
		const doc = [
			"Intro <!--c:xx11-->text",
			"",
			"| A | B |",
			"| - | - |",
			"<!--c:tt22-->| 1 | 2 |<!--/c:tt22-->",
			body("tt22"),
			"",
			"<!--/c:xx11-->- Item",
			body("xx11"),
		].join("\n");
		const pass = (text: string): string => {
			const result = computeRepairAnchors(text);
			if (result.isErr()) throw new Error(result.error);
			return applyChanges(text, result.value);
		};

		const once = pass(doc);
		expect(parseComments(once).find((comment) => comment.id === "xx11")?.close).not.toBeNull();
		expect(anchorDamage(pass(once)).size).toBe(0);
	});
});
