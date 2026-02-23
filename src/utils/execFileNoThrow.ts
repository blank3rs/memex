import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: "ok" | "error";
}

export async function execFileNoThrow(
  command: string,
  args: string[]
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 30000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), status: "ok" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? "",
      status: "error",
    };
  }
}

export function runAppleScript(script: string): Promise<ExecResult> {
  return execFileNoThrow("osascript", ["-e", script]);
}
