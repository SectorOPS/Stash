import { platform } from "node:os";
import { spawn } from "node:child_process";
import { shellJoin } from "./launch";

export interface NewWindowRequest {
  cwd: string;
  command: string[];
}

export type SpawnPlan =
  | { method: "tmux"; description: string }
  | { method: "osascript"; app: string; description: string }
  | { method: "exec"; binary: string; argv: string[]; description: string }
  | { method: "inline"; description: string };

/**
 * Open a new terminal window in `cwd` running `command`. Picks the best
 * available method for this host and falls back to an inline run if no new
 * window can be opened.
 */
export async function openInNewWindow(
  req: NewWindowRequest,
): Promise<SpawnPlan> {
  const detected = detect();
  const inner = buildInnerCommand(req.cwd, req.command);

  for (const method of detected) {
    const plan = await tryMethod(method, req, inner);
    if (plan) return plan;
  }

  // No new-window method worked — run inline as a last resort.
  await runInline(req);
  return {
    method: "inline",
    description:
      "no new-window method available; ran the command in this terminal",
  };
}

type Method =
  | "tmux"
  | "iterm"
  | "apple-terminal"
  | "ghostty"
  | "wezterm"
  | "kitty"
  | "warp"
  | "alacritty"
  | "gnome-terminal"
  | "konsole"
  | "xfce4-terminal"
  | "foot"
  | "xterm";

function detect(): Method[] {
  const list: Method[] = [];
  if (process.env["TMUX"]) list.push("tmux");

  const termProgram = (process.env["TERM_PROGRAM"] || "").toLowerCase();
  if (termProgram === "iterm.app") list.push("iterm");
  if (termProgram === "apple_terminal") list.push("apple-terminal");
  if (termProgram === "ghostty") list.push("ghostty");
  if (termProgram === "wezterm") list.push("wezterm");
  if (termProgram === "warp") list.push("warp");

  if (process.env["KITTY_LISTEN_ON"]) list.push("kitty");
  if (process.env["ALACRITTY_SOCKET"]) list.push("alacritty");

  if (platform() === "darwin") {
    // macOS fallback ladder if nothing matched yet — Terminal.app always exists.
    if (!list.includes("iterm")) list.push("iterm");
    if (!list.includes("apple-terminal")) list.push("apple-terminal");
  } else {
    // Linux fallback ladder.
    list.push(
      "wezterm",
      "kitty",
      "alacritty",
      "ghostty",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "foot",
      "xterm",
    );
  }

  return dedupe(list);
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function buildInnerCommand(cwd: string, command: string[]): string {
  // `cd && exec <cmd>` makes the terminal process == the resumed CLI, so when
  // the CLI exits the window closes cleanly.
  return `cd ${shqQuote(cwd)} && exec ${shellJoin(command)}`;
}

/**
 * Shell-quote a string for embedding inside a shell command. Differs from the
 * argv quoter in `launch.ts` only in name.
 */
function shqQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [bin], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function tryMethod(
  method: Method,
  req: NewWindowRequest,
  inner: string,
): Promise<SpawnPlan | null> {
  switch (method) {
    case "tmux":
      return runTmux(req, inner);
    case "iterm":
      return runItermOsa(inner);
    case "apple-terminal":
      return runAppleTerminalOsa(inner);
    case "ghostty":
      return runGhostty(req, inner);
    case "wezterm":
      return (await which("wezterm")) ? runWezterm(req, inner) : null;
    case "kitty":
      return (await which("kitty")) ? runKitty(req, inner) : null;
    case "warp":
      return runWarpOsa(inner);
    case "alacritty":
      return (await which("alacritty")) ? runAlacritty(req, inner) : null;
    case "gnome-terminal":
      return (await which("gnome-terminal"))
        ? runGnomeTerminal(req, inner)
        : null;
    case "konsole":
      return (await which("konsole")) ? runKonsole(req, inner) : null;
    case "xfce4-terminal":
      return (await which("xfce4-terminal"))
        ? runXfceTerminal(req, inner)
        : null;
    case "foot":
      return (await which("foot")) ? runFoot(req, inner) : null;
    case "xterm":
      return (await which("xterm")) ? runXterm(req, inner) : null;
  }
}

function detach(binary: string, argv: string[]): SpawnPlan {
  const child = spawn(binary, argv, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return {
    method: "exec",
    binary,
    argv,
    description: `spawned ${binary}`,
  };
}

function runTmux(req: NewWindowRequest, inner: string): SpawnPlan {
  // `tmux new-window` opens in the current tmux session/client.
  const argv = ["new-window", "-c", req.cwd, inner];
  spawn("tmux", argv, { stdio: "ignore" });
  return {
    method: "tmux",
    description: "opened a new tmux window in the current session",
  };
}

function runItermOsa(inner: string): SpawnPlan {
  // Newer iTerm scripting API: create a window with a default profile and run
  // the command. Quote the inner script for AppleScript by escaping " and \.
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "iTerm"
  activate
  create window with default profile
  tell current session of current window
    write text "${escaped}"
  end tell
end tell`;
  return detachOsa("iTerm", script);
}

function runAppleTerminalOsa(inner: string): SpawnPlan {
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "Terminal"
  activate
  do script "${escaped}"
end tell`;
  return detachOsa("Terminal", script);
}

function runWarpOsa(inner: string): SpawnPlan {
  // Warp doesn't expose a stable AppleScript API for "new window with command",
  // so we fall back to Terminal-style do-script via System Events. If that
  // fails (no Warp installed) `detect()` won't include warp anyway.
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "Warp"
  activate
end tell
delay 0.4
tell application "System Events"
  keystroke "n" using {command down}
  delay 0.3
  keystroke "${escaped}"
  key code 36
end tell`;
  return detachOsa("Warp", script);
}

function detachOsa(app: string, script: string): SpawnPlan {
  const child = spawn("osascript", ["-e", script], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return {
    method: "osascript",
    app,
    description: `opened a new ${app} window via osascript`,
  };
}

function runGhostty(req: NewWindowRequest, inner: string): SpawnPlan {
  // Ghostty's CLI: `ghostty --working-directory=<dir> -e <cmd>` opens a new
  // window. The `-e` form passes the rest as argv to the shell.
  return detach("ghostty", [
    `--working-directory=${req.cwd}`,
    "-e",
    "sh",
    "-c",
    inner,
  ]);
}

function runWezterm(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("wezterm", [
    "start",
    "--cwd",
    req.cwd,
    "--",
    "sh",
    "-c",
    inner,
  ]);
}

function runKitty(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("kitty", ["--directory", req.cwd, "sh", "-c", inner]);
}

function runAlacritty(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("alacritty", [
    "--working-directory",
    req.cwd,
    "-e",
    "sh",
    "-c",
    inner,
  ]);
}

function runGnomeTerminal(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("gnome-terminal", [
    `--working-directory=${req.cwd}`,
    "--",
    "sh",
    "-c",
    inner,
  ]);
}

function runKonsole(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("konsole", ["--workdir", req.cwd, "-e", "sh", "-c", inner]);
}

function runXfceTerminal(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("xfce4-terminal", [
    `--working-directory=${req.cwd}`,
    "-e",
    `sh -c ${shqQuote(inner)}`,
  ]);
}

function runFoot(req: NewWindowRequest, inner: string): SpawnPlan {
  return detach("foot", [
    `--working-directory=${req.cwd}`,
    "sh",
    "-c",
    inner,
  ]);
}

function runXterm(_req: NewWindowRequest, inner: string): SpawnPlan {
  // xterm has no cwd flag; cd is already inside `inner`.
  return detach("xterm", ["-e", "sh", "-c", inner]);
}

async function runInline(req: NewWindowRequest): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(req.command[0]!, req.command.slice(1), {
      cwd: req.cwd,
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
}
