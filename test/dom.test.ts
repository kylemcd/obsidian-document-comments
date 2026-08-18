// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { isHtmlElement } from "../src/util/dom";

describe("realm-safe DOM guards", () => {
	test("accepts an HTMLElement created by another window realm", () => {
		class ForeignHTMLElement {}
		const element = Object.assign(new ForeignHTMLElement(), {
			nodeType: 1,
			ownerDocument: { defaultView: { HTMLElement: ForeignHTMLElement } },
		});

		expect(element instanceof HTMLElement).toBe(false);
		expect(isHtmlElement(element)).toBe(true);
	});

	test("rejects non-elements", () => {
		expect(isHtmlElement(null)).toBe(false);
		expect(isHtmlElement({ nodeType: 3 })).toBe(false);
	});
});
