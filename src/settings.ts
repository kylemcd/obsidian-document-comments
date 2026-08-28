import { App, PluginSettingTab, Setting, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type DocCommentsPlugin from "./main";
import type { AuthorColorAssignments } from "./author-colors";

export type DocCommentsSettings = {
	/** Author handle attached to comments you create. Empty falls back to "me". */
	author: string;
	/** Author handles available when composing comments and replies. */
	authors: string[];
	/** Master toggle for the margin column. */
	showComments: boolean;
	/** Show resolved comments in the margin. */
	showResolved: boolean;
	/** Show the in-text highlight underlines even when the comment column is hidden. */
	showHighlights: boolean;
	/** Clicking a highlight when the comment column is hidden opens the sidebar panel. */
	highlightsOpenSidebar: boolean;
	/** Allow a blank comment to persist with an empty comment card. */
	allowEmptyComments: boolean;
	/** Apply stored per-author colors to highlights and author names. */
	authorColorsEnabled: boolean;
	/** Local, persistent colors keyed by the canonical original highlight creator. */
	authorColors: AuthorColorAssignments;
	/** Authors whose generated mapping was explicitly deleted. */
	excludedAuthorColors: string[];
};

export const DEFAULT_SETTINGS: DocCommentsSettings = {
	author: "",
	authors: [],
	showComments: true,
	showResolved: false,
	showHighlights: true,
	highlightsOpenSidebar: true,
	allowEmptyComments: false,
	authorColorsEnabled: false,
	authorColors: {},
	excludedAuthorColors: [],
};

type DocCommentsSettingKey = Exclude<keyof DocCommentsSettings, "authorColors" | "excludedAuthorColors">;

const isBooleanKey = (key: DocCommentsSettingKey): boolean =>
	[
		"showComments",
		"showResolved",
		"showHighlights",
		"highlightsOpenSidebar",
		"allowEmptyComments",
		"authorColorsEnabled",
	].includes(key);

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
		key: "authors",
		name: "Available authors",
		desc: "Comma-separated names you can choose when writing comments. The current Author is always included.",
		aliases: ["people", "identities", "comment authors"],
		control: { type: "text", placeholder: "Alice, Bob" },
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
	{
		key: "showHighlights",
		name: "Show highlights",
		desc: "Show the colored underlines in the text even when the comment column is hidden.",
		aliases: ["text highlights", "underlines"],
		control: { type: "toggle" },
	},
	{
		key: "highlightsOpenSidebar",
		name: "Highlights open sidebar",
		desc: "Clicking a highlighted comment range opens the sidebar panel when the comment column is hidden.",
		aliases: ["highlight click", "open sidebar"],
		control: { type: "toggle" },
	},
	{
		key: "allowEmptyComments",
		name: "Allow empty comments",
		desc: "Allow new comments without text. Existing empty comments remain available when this setting is off.",
		aliases: ["empty comments", "comment-free highlights"],
		control: { type: "toggle" },
	},
	{
		key: "authorColorsEnabled",
		name: "Use author colors",
		desc: "Color highlights and author names by person. Turning this off restores yellow highlights and keeps every saved assignment.",
		aliases: ["highlight colors", "people colors", "disable colors"],
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

	getSettingDefinitions(): SettingDefinitionItem<string>[] {
		const base: SettingDefinitionItem<string>[] = SETTING_META.map((meta) => ({
			name: meta.name,
			desc: meta.desc,
			aliases: meta.aliases,
			control:
				meta.control.type === "text"
					? {
							type: "text",
							key: meta.key,
							defaultValue:
								meta.key === "authors"
									? (this.plugin.settings.authors ?? DEFAULT_SETTINGS.authors).join(", ")
									: String(this.plugin.settings[meta.key] ?? DEFAULT_SETTINGS[meta.key]),
							placeholder: meta.control.placeholder,
						}
					: { type: "toggle", key: meta.key, defaultValue: this.plugin.settings[meta.key] as boolean },
		}));
		const settingsError = this.plugin.settingsError();
		if (settingsError) base.push(this.settingsErrorDefinition(settingsError));
		if (!this.plugin.settings.authorColorsEnabled) return base;
		return [...base, this.authorColorGroup()];
	}

	getControlValue(key: string): unknown {
		if (key === "authors") return (this.plugin.settings.authors ?? []).join(", ");
		return this.plugin.settings[key as DocCommentsSettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.applySetting(key as DocCommentsSettingKey, value);
	}

	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.replaceChildren();
		for (const meta of SETTING_META) {
			const setting = new Setting(containerEl).setName(meta.name).setDesc(meta.desc);
			if (meta.control.type === "text") {
				const placeholder = meta.control.placeholder;
				setting.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(
							meta.key === "authors"
								? (this.plugin.settings.authors ?? []).join(", ")
								: String(this.plugin.settings[meta.key]),
						)
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
		const settingsError = this.plugin.settingsError();
		if (settingsError) new Setting(containerEl).setName("Settings error").setDesc(settingsError);
		if (!this.plugin.settings.authorColorsEnabled) return;

		new Setting(containerEl).setName("Highlight colors").setHeading();
		this.configureIndexStatus(new Setting(containerEl));
		const { active, missing, uncolored } = this.plugin.authorColorView();
		active.forEach((author) => this.configureAuthorColorRow(new Setting(containerEl), author, false));
		if (missing.length > 0) {
			new Setting(containerEl).setName("Not currently found").setHeading();
			missing.forEach((author) => this.configureAuthorColorRow(new Setting(containerEl), author, true));
		}
		if (uncolored.length === 0) return;
		new Setting(containerEl).setName("Uncolored").setHeading();
		uncolored.forEach((author) => this.configureUncoloredAuthorRow(new Setting(containerEl), author));
	}

	refresh(): void {
		const dynamicTab = this as unknown as { update?: () => void };
		if (dynamicTab.update) {
			dynamicTab.update();
			return;
		}
		this.renderLegacy();
	}

	private authorColorGroup(): SettingDefinitionItem<string> {
		const { active, missing, uncolored } = this.plugin.authorColorView();
		const authorRow = (author: string, unavailable: boolean): SettingDefinition<string> => ({
			name: author,
			desc: unavailable ? "This creator is not currently found in the vault." : undefined,
			render: (setting) => this.configureAuthorColorRow(setting, author, unavailable),
		});
		const uncoloredRow = (author: string): SettingDefinition<string> => ({
			name: author,
			desc: "No color assigned. Uses the normal theme text color.",
			render: (setting) => this.configureUncoloredAuthorRow(setting, author),
		});
		const missingHeading: SettingDefinition<string>[] =
			missing.length === 0
				? []
				: [
						{
							name: "Not currently found",
							searchable: false,
							render: (setting) => {
								setting.setName("Not currently found").setHeading();
							},
						},
					];
		const uncoloredHeading: SettingDefinition<string>[] =
			uncolored.length === 0
				? []
				: [
						{
							name: "Uncolored",
							searchable: false,
							render: (setting) => {
								setting.setName("Uncolored").setHeading();
							},
						},
					];
		return {
			type: "group",
			heading: "Highlight colors",
			items: [
				{
					name: "Highlight color index",
					searchable: false,
					render: (setting) => this.configureIndexStatus(setting),
				},
				...active.map((author) => authorRow(author, false)),
				...missingHeading,
				...missing.map((author) => authorRow(author, true)),
				...uncoloredHeading,
				...uncolored.map(uncoloredRow),
			],
		};
	}

	private configureIndexStatus(setting: Setting): void {
		const { state, saveError } = this.plugin.authorColorView();
		const description =
			state.status === "idle"
				? "Waiting to scan Markdown files for highlight creators."
				: state.status === "scanning"
					? "Scanning Markdown files for highlight creators…"
					: state.status === "partial"
						? `Found creators, but ${state.errors.length} file${state.errors.length === 1 ? "" : "s"} could not be read.`
						: "Colors are stored locally in this plugin's data.json file.";
		setting.setName("Creators").setDesc(saveError ? `${description} ${saveError}` : description);
		setting.addButton((button) =>
			button
				.setButtonText("Rescan")
				.setDisabled(state.status === "scanning")
				.onClick(() => void this.plugin.rescanAuthors()),
		);
	}

	private configureAuthorColorRow(setting: Setting, author: string, unavailable: boolean): void {
		const assignment = this.plugin.settings.authorColors[author];
		if (!assignment) return;
		setting.settingEl.classList.add("dc-author-color-setting");
		const row = setting.setName(author);
		if (unavailable) row.setDesc("This creator is not currently found in the vault.");
		row.addColorPicker((picker) =>
			picker.setValue(assignment.color).onChange((value) => void this.plugin.setAuthorColor(author, value)),
		);
		row.addExtraButton((button) =>
			button
				.setIcon("trash-2")
				.setTooltip("Delete this color assignment")
				.onClick(() => void this.plugin.deleteAuthorColor(author)),
		);
	}

	private configureUncoloredAuthorRow(setting: Setting, author: string): void {
		setting.settingEl.classList.add("dc-author-color-setting");
		setting
			.setName(author)
			.setDesc("No color assigned. Uses the normal theme text color.")
			.addButton((button) =>
				button.setButtonText("Assign color").onClick(() => void this.plugin.restoreAuthorColor(author)),
			)
			.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove this author from colors")
					.onClick(() => void this.plugin.removeAuthorColor(author)),
			);
	}

	private settingsErrorDefinition(message: string): SettingDefinition<string> {
		return {
			name: "Settings error",
			desc: message,
			searchable: false,
			render: (setting) => {
				setting.setName("Settings error").setDesc(message);
			},
		};
	}

	private assignSetting(key: DocCommentsSettingKey, value: unknown): void {
		if (key === "author") this.plugin.settings.author = String(value);
		else if (key === "authors") {
			this.plugin.settings.authors = String(value)
				.split(",")
				.map((author) => author.trim())
				.filter((author, index, authors) => author.length > 0 && authors.indexOf(author) === index);
		} else if (key === "showComments") this.plugin.settings.showComments = Boolean(value);
		else if (key === "showResolved") this.plugin.settings.showResolved = Boolean(value);		else if (key === "showHighlights") this.plugin.settings.showHighlights = Boolean(value);
		else if (key === "highlightsOpenSidebar") this.plugin.settings.highlightsOpenSidebar = Boolean(value);		else if (key === "allowEmptyComments") this.plugin.settings.allowEmptyComments = Boolean(value);
		else if (key === "authorColorsEnabled") this.plugin.settings.authorColorsEnabled = Boolean(value);
	}

	/** Persist one setting and run its side effects (editor refresh, ribbon sync).
	 *  Shared by both the declarative and imperative settings paths. */
	private async applySetting(key: DocCommentsSettingKey, value: unknown): Promise<void> {
		const previous = this.plugin.settings[key];
		this.assignSetting(key, value);
		const saved = await this.plugin.saveSettings();
		if (saved.isErr()) {
			this.assignSetting(key, previous);
			this.refresh();
			return;
		}
		this.plugin.refreshEditors();
		if (key === "showComments") this.plugin.updateRibbon();
		this.refresh();
	}
}
