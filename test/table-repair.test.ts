import { describe, expect, test } from "vitest";
import { brokenTableAnchors, computeRepairTableAnchors } from "../src/editor/table-repair";
import { applyChanges } from "../src/editor/edits";
import { parseComments } from "../src/format/parse";

const body = (id: string, quote: string) =>
	[`<!--co:${id} by:me at:2026-01-01T00:00:00.000Z status:open quote:"${quote}"`, "me: hi", "-->"].join("\n");

const repair = (doc: string) => {
	const result = computeRepairTableAnchors(doc);
	if (result.isErr()) throw new Error(result.error);
	return applyChanges(doc, result.value);
};

describe("brokenTableAnchors", () => {
	test("finds an anchor that displaced a row's leading pipe", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			"| Tuesday | review |",
			body("aa11", "x"),
		].join("\n");

		expect([...brokenTableAnchors(doc)]).toEqual(["aa11"]);
	});

	test("finds an anchor that displaced the header's trailing pipe", () => {
		const doc = ["| Day | Task |<!--/c:aa11-->", "| --- | --- |", "| Monday | spec |", body("aa11", "x")].join(
			"\n",
		);
		const withOpen = doc.replace("| Day", "<!--c:aa11-->| Day");

		expect([...brokenTableAnchors(withOpen)]).toEqual(["aa11"]);
	});

	test("leaves a healthy in-cell anchor alone", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"| Monday | <!--c:aa11-->spec<!--/c:aa11--> |",
			body("aa11", "spec"),
		].join("\n");

		expect([...brokenTableAnchors(doc)]).toEqual([]);
	});

	test("does not flag prose that merely starts with a pipe", () => {
		// The line looks damaging, but no table appears when the markers come off,
		// which is what the block-scoped confirmation is for.
		const doc = ["Some prose.", "", "<!--c:aa11-->| not a table | at all<!--/c:aa11-->", body("aa11", "x")].join(
			"\n",
		);

		expect([...brokenTableAnchors(doc)]).toEqual([]);
	});

	test("is empty for a document with no comments", () => {
		expect([...brokenTableAnchors("| Day |\n| --- |\n| Monday |")]).toEqual([]);
	});
});

describe("computeRepairTableAnchors", () => {
	test("moves the anchor inside the row and restores the table", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			"| Tuesday | review |",
			body("aa11", "x"),
		].join("\n");

		const out = repair(doc);

		expect(out).toContain("| <!--c:aa11-->Monday | spec<!--/c:aa11--> |");
		expect(brokenTableAnchors(out)).toEqual(new Set());
	});

	test("repairs two broken anchors in the same table", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			"<!--c:bb22-->| Tuesday | review |<!--/c:bb22-->",
			body("aa11", "x"),
			body("bb22", "y"),
		].join("\n");

		const out = repair(doc);

		expect(brokenTableAnchors(out)).toEqual(new Set());
		expect(out).toContain("| <!--c:aa11-->Monday | spec<!--/c:aa11--> |");
		expect(out).toContain("| <!--c:bb22-->Tuesday | review<!--/c:bb22--> |");
	});

	test("keeps a healthy neighbour's markers exactly where they were", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			"| Tuesday | <!--c:bb22-->review<!--/c:bb22--> |",
			body("aa11", "x"),
			body("bb22", "review"),
		].join("\n");

		const out = repair(doc);

		expect(out).toContain("| Tuesday | <!--c:bb22-->review<!--/c:bb22--> |");
		expect(brokenTableAnchors(out)).toEqual(new Set());
	});

	test("keeps a nested anchor intact while repairing the one around it", () => {
		// A legacy whole-table anchor around a healthy in-cell comment is exactly the
		// shape repair exists to undo, and the two ranges nest. Reinserting anchor by
		// anchor used to shift the outer end and split the inner close marker in half.
		const doc = [
			"<!--c:aa11-->| Day | Task |",
			"| --- | --- |",
			"| Monday | <!--c:bb22-->spec<!--/c:bb22--> |",
			"| Tuesday | review |<!--/c:aa11-->",
			body("aa11", "whole table"),
			body("bb22", "spec"),
		].join("\n");

		const out = repair(doc);

		expect(out).toContain("| Monday | <!--c:bb22-->spec<!--/c:bb22--> |");
		expect(out).not.toContain("<!--/c:b<");
		expect(parseComments(out).map((c) => [c.id, !!c.open, !!c.close])).toEqual([
			["aa11", true, true],
			["bb22", true, true],
		]);
		expect(brokenTableAnchors(out)).toEqual(new Set());
	});

	test("does not flag a healthy anchor nested inside a broken one", () => {
		const doc = [
			"<!--c:aa11-->| Day | Task |",
			"| --- | --- |",
			"| Monday | <!--c:bb22-->spec<!--/c:bb22--> |",
			"| Tuesday | review |<!--/c:aa11-->",
			body("aa11", "whole table"),
			body("bb22", "spec"),
		].join("\n");

		expect([...brokenTableAnchors(doc)]).toEqual(["aa11"]);
	});

	test("leaves the body block and thread untouched", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			body("aa11", "x"),
		].join("\n");

		expect(repair(doc)).toContain(body("aa11", "x"));
	});

	test("writes nothing when there is nothing to repair", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"| Monday | <!--c:aa11-->spec<!--/c:aa11--> |",
			body("aa11", "spec"),
		].join("\n");
		const result = computeRepairTableAnchors(doc);

		expect(result.isOk() && result.value).toEqual([]);
	});

	test("honors an id filter", () => {
		const doc = [
			"| Day | Task |",
			"| --- | --- |",
			"<!--c:aa11-->| Monday | spec |<!--/c:aa11-->",
			body("aa11", "x"),
		].join("\n");
		const result = computeRepairTableAnchors(doc, new Set(["other"]));

		expect(result.isOk() && result.value).toEqual([]);
	});
});
