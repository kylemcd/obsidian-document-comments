import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type DocCommentsPlugin from "./main";

export type DocCommentsSettings = {
	/** Author handle attached to comments you create. Empty falls back to "me". */
	author: string;
	/** Master toggle for the margin column. */
	showComments: boolean;
	/** Show resolved comments in the margin. */
	showResolved: boolean;
};

export const DEFAULT_SETTINGS: DocCommentsSettings = {
	author: "",
	showComments: true,
	showResolved: false,
};

type DocCommentsSettingKey = keyof DocCommentsSettings;

type TextControl = { type: "text"; placeholder: string };
type ToggleControl = { type: "toggle" };

/** Single source of truth for each setting's copy and control. Both the
 *  declarative `getSettingDefinitions()` API (newer Obsidian) and the imperative
 *  `display()` fallback (older Obsidian) render from this, so their labels and
 *  defaults can't drift apart. */
const SETTING_META: ReadonlyArray<{
	key: DocCommentsSettingKey;
	name: string;
	desc: string;
	aliases: string[];
	control: TextControl | ToggleControl;
}> = [
	{
		key: "author",
		name: "Author",
		desc: 'Name attached to comments you create. Defaults to "me".',
		aliases: ["comment author", "display name"],
		control: { type: "text", placeholder: "Me" },
	},
	{
		key: "showComments",
		name: "Show comments",
		desc: "Show the comment column. You can also toggle this from the ribbon or the command palette.",
		aliases: ["comment column", "margin comments"],
		control: { type: "toggle" },
	},
	{
		key: "showResolved",
		name: "Show resolved comments",
		desc: "Keep resolved comments visible in the margin.",
		aliases: ["resolved comments"],
		control: { type: "toggle" },
	},
];

export class DocCommentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DocCommentsPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<DocCommentsSettingKey>[] {
		return SETTING_META.map((meta) => ({
			name: meta.name,
			desc: meta.desc,
			aliases: meta.aliases,
			control:
				meta.control.type === "text"
					? {
							type: "text",
							key: meta.key,
							defaultValue: DEFAULT_SETTINGS[meta.key] as string,
							placeholder: meta.control.placeholder,
						}
					: { type: "toggle", key: meta.key, defaultValue: DEFAULT_SETTINGS[meta.key] as boolean },
		}));
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.applySetting(key as DocCommentsSettingKey, value);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const meta of SETTING_META) {
			const setting = new Setting(containerEl).setName(meta.name).setDesc(meta.desc);
			if (meta.control.type === "text") {
				const placeholder = meta.control.placeholder;
				setting.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(String(this.plugin.settings[meta.key]))
						.onChange((value) => void this.applySetting(meta.key, value)),
				);
			} else {
				setting.addToggle((toggle) =>
					toggle
						.setValue(Boolean(this.plugin.settings[meta.key]))
						.onChange((value) => void this.applySetting(meta.key, value)),
				);
			}
		}
	}

	/** Persist one setting and run its side effects (editor refresh, ribbon sync).
	 *  Shared by both the declarative and imperative settings paths. */
	private async applySetting(key: DocCommentsSettingKey, value: unknown): Promise<void> {
		if (key === "author") this.plugin.settings.author = String(value);
		else if (key === "showComments") this.plugin.settings.showComments = Boolean(value);
		else if (key === "showResolved") this.plugin.settings.showResolved = Boolean(value);
		await this.plugin.saveSettings();
		if (key !== "author") this.plugin.refreshEditors();
		if (key === "showComments") this.plugin.updateRibbon();
	}
}
