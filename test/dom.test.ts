// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { isHtmlElement, isImeComposing } from "../src/util/dom";

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

describe("isImeComposing", () => {
	const keydown = (overrides: { isComposing?: boolean; keyCode?: number }): KeyboardEvent => {
		const event = new KeyboardEvent("keydown", { key: "Enter" });
		Object.entries(overrides).forEach(([name, value]) => Object.defineProperty(event, name, { value }));
		return event;
	};

	test("is true while the IME is composing", () => {
		expect(isImeComposing(keydown({ isComposing: true }))).toBe(true);
	});

	test("is true for WebKit's committing Enter, which arrives after composition ends", () => {
		expect(isImeComposing(keydown({ isComposing: false, keyCode: 229 }))).toBe(true);
	});

	test("is false for a plain Enter", () => {
		expect(isImeComposing(keydown({ isComposing: false, keyCode: 13 }))).toBe(false);
	});
});
