import { Result } from "better-result";

export type SettingsStorageError =
	| { type: "settings_load_failed"; message: string }
	| { type: "settings_save_failed"; message: string };

const errorMessage = (error: unknown): string => {
	return error instanceof Error ? error.message : "Unknown settings storage error";
};

export const loadSettingsData = async (
	loadData: () => Promise<unknown>,
): Promise<Result<unknown, SettingsStorageError>> => {
	return Result.tryPromise({
		try: loadData,
		catch: (error) => ({ type: "settings_load_failed", message: errorMessage(error) }),
	});
};

export const saveSettingsData = async (
	saveData: (data: unknown) => Promise<void>,
	data: unknown,
): Promise<Result<void, SettingsStorageError>> => {
	return Result.tryPromise({
		try: () => saveData(data),
		catch: (error) => ({ type: "settings_save_failed", message: errorMessage(error) }),
	});
};
