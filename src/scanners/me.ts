import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileNoThrow, runAppleScript } from "../utils/execFileNoThrow.js";

export interface MeCard {
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  jobTitle: string;
  birthday: string;
  socials: string[];
  note: string;
  source: string;
}

const EMPTY: MeCard = {
  name: "", emails: [], phones: [], company: "",
  jobTitle: "", birthday: "", socials: [], note: "", source: "",
};

// 1. Try the Contacts "Me" card (only works if user has set it)
async function fromContactsMyCard(): Promise<MeCard | null> {
  const script = `
tell application "Contacts"
  set p to my card
  set fn to ""
  try
    set fn to first name of p
    if fn is missing value then set fn to ""
  end try
  set ln to ""
  try
    set ln to last name of p
    if ln is missing value then set ln to ""
  end try
  set emailList to ""
  try
    repeat with e in every email of p
      set emailList to emailList & value of e & ";"
    end repeat
  end try
  set co to ""
  try
    set co to organization of p
    if co is missing value then set co to ""
  end try
  set jt to ""
  try
    set jt to job title of p
    if jt is missing value then set jt to ""
  end try
  set socialList to ""
  try
    repeat with s in every social profile of p
      set socialList to socialList & username of s & " (" & service name of s & ");"
    end repeat
  end try
  return (fn & " " & ln) & "|" & emailList & "|" & co & "|" & jt & "|" & socialList
end tell
  `;
  const result = await runAppleScript(script);
  if (result.status === "error" || !result.stdout?.trim()) return null;

  const [fullName, emailStr, company, jobTitle, socialStr] = result.stdout.split("|");
  const name = fullName?.trim() ?? "";
  if (!name || name === " ") return null;

  return {
    ...EMPTY,
    name,
    emails: (emailStr ?? "").split(";").map((e) => e.trim()).filter(Boolean),
    company: company?.trim() ?? "",
    jobTitle: jobTitle?.trim() ?? "",
    socials: (socialStr ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    source: "contacts-me-card",
  };
}

// 2. macOS system full name via `id -F`
async function fromSystemFullName(): Promise<MeCard | null> {
  const result = await execFileNoThrow("id", ["-F"]);
  const name = result.stdout?.trim();
  if (!name || result.status === "error") return null;
  return { ...EMPTY, name, source: "system" };
}

// 3. macOS directory services (more reliable than id -F on some setups)
async function fromDscl(): Promise<MeCard | null> {
  const username = os.userInfo().username;
  const result = await execFileNoThrow("dscl", [".", "-read", `/Users/${username}`, "RealName"]);
  if (result.status === "error") return null;
  const match = result.stdout.match(/RealName:\s*\n?\s*(.+)/);
  const name = match?.[1]?.trim();
  if (!name) return null;
  return { ...EMPTY, name, source: "dscl" };
}

// 4. Git config name + email
async function fromGitConfig(): Promise<MeCard | null> {
  const gitConfigPath = path.join(os.homedir(), ".gitconfig");
  if (!fs.existsSync(gitConfigPath)) return null;

  const config = fs.readFileSync(gitConfigPath, "utf-8");
  const nameMatch = config.match(/^\s*name\s*=\s*(.+)$/m);
  const emailMatch = config.match(/^\s*email\s*=\s*(.+)$/m);

  const name = nameMatch?.[1]?.trim();
  const email = emailMatch?.[1]?.trim();
  if (!name) return null;

  return {
    ...EMPTY,
    name,
    emails: email ? [email] : [],
    source: "git-config",
  };
}

// 5. Last resort: capitalize the system username
function fromUsername(): MeCard {
  const username = os.userInfo().username;
  const name = username
    .split(/[._-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return { ...EMPTY, name, source: "username" };
}

export async function scanMeCard(): Promise<MeCard> {
  const result =
    (await fromContactsMyCard()) ??
    (await fromSystemFullName()) ??
    (await fromDscl()) ??
    (await fromGitConfig()) ??
    fromUsername();

  return result;
}

export function buildBioFromCard(me: MeCard): string {
  const parts: string[] = [];
  if (me.jobTitle && me.company) parts.push(`${me.jobTitle} at ${me.company}`);
  else if (me.jobTitle) parts.push(me.jobTitle);
  else if (me.company) parts.push(me.company);
  if (me.emails[0]) parts.push(me.emails[0]);
  if (me.socials.length) parts.push(me.socials.join(", "));
  return parts.join(" · ");
}
