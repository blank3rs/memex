import inquirer from "inquirer";
import chalk from "chalk";
import { execFileNoThrow } from "./execFileNoThrow.js";

export type PermissionType =
  | "contacts"
  | "calendar"
  | "reminders"
  | "notes"
  | "full-disk";

const SETTINGS_URLS: Record<PermissionType, string> = {
  contacts:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  calendar:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  reminders:  "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
  notes:      "x-apple.systempreferences:com.apple.preference.security?Privacy_Notes",
  "full-disk":"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

const LABELS: Record<PermissionType, string> = {
  contacts:    "Contacts",
  calendar:    "Calendars",
  reminders:   "Reminders",
  notes:       "Notes",
  "full-disk": "Full Disk Access",
};

export async function requestPermission(type: PermissionType): Promise<boolean> {
  const label = LABELS[type];
  const url = SETTINGS_URLS[type];

  console.log(
    chalk.yellow(`\n  memex needs access to ${chalk.bold(label)}.\n`) +
    chalk.gray("  Opening System Settings now...\n")
  );

  await execFileNoThrow("open", [url]);

  const { ready } = await inquirer.prompt([{
    type: "confirm",
    name: "ready",
    message: `Grant access to ${label} in System Settings, then press Enter to retry (or No to skip):`,
    default: true,
  }]);

  return ready as boolean;
}
