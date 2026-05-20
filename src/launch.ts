import { spawn } from "node:child_process";
import type { LaunchOptions, Tool } from "./types";
import { openInNewWindow, type SpawnPlan } from "./terminal";

/**
 * Build the argv that resumes / forks / starts a session for the given tool.
 *
 * - claude   : `claude --resume <id> [--fork-session]` or just `claude`.
 *              Skip-permissions adds `--dangerously-skip-permissions`.
 * - codex    : `codex resume <id>` (or `codex fork <id>` when fork=true).
 *              No id → just `codex`. Skip-permissions adds
 *              `--dangerously-bypass-approvals-and-sandbox`.
 * - opencode : `opencode --session <id> [--fork]` or `opencode`. No
 *              documented skip-permissions flag — that option is silently
 *              dropped.
 *
 * Fork semantics differ across tools (claude copies+switches, codex creates
 * a new rollout referencing the parent, opencode does a sibling); the row
 * label in the picker stays the same and the result is the same from the
 * user's perspective — new session id, parent untouched, you're launched
 * into the child.
 */
export function buildCommand(opts: LaunchOptions): string[] {
  const fork = opts.fork === true && opts.sessionId !== null;
  switch (opts.tool) {
    case "claude": {
      const cmd: string[] = ["claude"];
      if (opts.sessionId) cmd.push("--resume", opts.sessionId);
      if (fork) cmd.push("--fork-session");
      if (opts.skipPermissions) cmd.push("--dangerously-skip-permissions");
      return cmd;
    }
    case "codex": {
      const cmd: string[] = ["codex"];
      if (opts.sessionId) cmd.push(fork ? "fork" : "resume", opts.sessionId);
      if (opts.skipPermissions) cmd.push("--dangerously-bypass-approvals-and-sandbox");
      return cmd;
    }
    case "opencode": {
      const cmd: string[] = ["opencode"];
      if (opts.sessionId) {
        cmd.push("--session", opts.sessionId);
        if (fork) cmd.push("--fork");
      }
      // opencode has no documented skip-permissions flag at the CLI level.
      return cmd;
    }
  }
}

export function toolSupportsSkipPermissions(tool: Tool): boolean {
  return tool === "claude" || tool === "codex";
}

/** Quote one argv token for a POSIX shell command line. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export interface LaunchResult {
  plan: SpawnPlan;
}

/**
 * Launch the resume command. When `newWindow` is true, spawn a fresh terminal
 * window in the project dir and run the command there. Otherwise exec the
 * command in the current TTY (replacing this Node process).
 */
export async function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const argv = buildCommand(opts);

  if (opts.newWindow) {
    const plan = await openInNewWindow({
      cwd: opts.dir,
      command: argv,
    });
    return { plan };
  }

  // Exec in place: we want the resumed CLI to take over the foreground. Use
  // `spawn` with stdio: 'inherit' and exit when the child exits. Bun lacks
  // a true POSIX exec() so this is the closest equivalent.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.dir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 0;
      resolve();
    });
  });

  return { plan: { method: "inline", description: "ran in current terminal" } };
}
