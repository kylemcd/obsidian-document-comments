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

export class DocCommentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DocCommentsPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<DocCommentsSettingKey>[] {
		return [
			{
				name: "Author",
				desc: 'Name attached to comments you create. Defaults to "me".',
				aliases: ["comment author", "display name"],
				control: {
					type: "text",
					key: "author",
					defaultValue: DEFAULT_SETTINGS.author,
					placeholder: "Me",
				},
			},
			{
				name: "Show comments",
				desc: "Show the comment column. You can also toggle this from the ribbon or the command palette.",
				aliases: ["comment column", "margin comments"],
				control: {
					type: "toggle",
					key: "showComments",
					defaultValue: DEFAULT_SETTINGS.showComments,
				},
			},
			{
				name: "Show resolved comments",
				desc: "Keep resolved comments visible in the margin.",
				aliases: ["resolved comments"],
				control: {
					type: "toggle",
					key: "showResolved",
					defaultValue: DEFAULT_SETTINGS.showResolved,
				},
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "author":
				this.plugin.settings.author = String(value);
				await this.plugin.saveSettings();
				break;
			case "showComments":
				this.plugin.settings.showComments = Boolean(value);
				await this.plugin.saveSettings();
				this.plugin.refreshEditors();
				break;
			case "showResolved":
				this.plugin.settings.showResolved = Boolean(value);
				await this.plugin.saveSettings();
				this.plugin.refreshEditors();
				break;
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Author")
			.setDesc("Name attached to comments you create. Defaults to “me”.")
			.addText((text) =>
				text
					.setPlaceholder("Me")
					.setValue(this.plugin.settings.author)
					.onChange(async (value) => {
						this.plugin.settings.author = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show comments")
			.setDesc("Show the comment column. You can also toggle this from the ribbon or the command palette.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showComments).onChange(async (value) => {
					this.plugin.settings.showComments = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
				}),
			);

		new Setting(containerEl)
			.setName("Show resolved comments")
			.setDesc("Keep resolved comments visible in the margin.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showResolved).onChange(async (value) => {
					this.plugin.settings.showResolved = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
				}),
			);
	}
}
