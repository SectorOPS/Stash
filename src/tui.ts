import * as p from "@clack/prompts";
import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import pc from "picocolors";
import {
  ALL_TOOLS,
  type LaunchOptions,
  type ProjectGroup,
  type Registry,
  type Session,
  type Tool,
} from "./types";
import {
  findByDir,
  loadRegistry,
  recordLastSession,
  removeProject,
  saveRegistry,
  upsertProject,
} from "./registry";
import { discoverAll } from "./discover";
import { buildCommand, shellJoin, toolSupportsSkipPermissions } from "./launch";
import { deleteSessions, findDuplicateSessions } from "./delete";
import { dim, timeAgo, tildeify, toolBadge, truncate } from "./format";
import { toggleSelect } from "./select";
import { printLogo } from "./logo";
import { sweepable, clutterReason } from "./clutter";

const CANCEL = Symbol("cancel");

function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

interface MenuPickOptions {
  newWindow: boolean;
  skipPermissions: boolean;
}

/** Top-level interactive launcher. Loops on the project picker so that
 *  "Back" from a sessionMenu re-opens the picker instead of exiting. */
export async function runInteractive(initial: {
  newWindow: boolean;
  skipPermissions: boolean;
}): Promise<LaunchOptions | null> {
  console.clear();
  printLogo();
  p.intro(pc.bgMagenta(pc.black(" stash ")) + dim("  resume across tools"));

  let registry = await loadRegistry();
  let state = await discoverAll(registry.projects);

  while (true) {
    const sweepables = sweepable(state.allGroups);
    const choice = await pickProject(state.groups, registry, sweepables);

    if (choice === CANCEL) {
      p.cancel("Cancelled.");
      return null;
    }

    if (choice === "add") {
      const added = await addProjectFlow(registry);
      if (!added) continue;
      registry = added.registry;
      state = await discoverAll(registry.projects);
      const group = state.groups.find((g) => g.directory === added.project.dir);
      if (!group) {
        p.note("Project registered. Run `stash` again to launch it.", "Added");
        continue;
      }
      const result = await sessionMenu(group, registry, initial);
      if (result === "back") continue;
      return result;
    }

    if (choice === "remove") {
      await removeProjectFlow(registry);
      // Re-discover so the picker reflects the registry change immediately.
      state = await discoverAll(registry.projects);
      continue;
    }

    if (choice === "purge") {
      const purged = await purgeProjectFlow(state.allGroups);
      if (purged) {
        state = await discoverAll(registry.projects);
      }
      continue;
    }

    if (choice === "sweep") {
      const swept = await sweepClutterFlow(sweepables);
      if (swept) {
        state = await discoverAll(registry.projects);
      }
      continue;
    }

    const result = await sessionMenu(choice, registry, initial);
    if (result === "back") {
      // Refresh discovery in case a session was deleted from the menu.
      state = await discoverAll(registry.projects);
      continue;
    }
    return result;
  }
}

async function pickProject(
  groups: ProjectGroup[],
  registry: Registry,
  sweepable: ProjectGroup[],
): Promise<
  ProjectGroup | "add" | "remove" | "purge" | "sweep" | typeof CANCEL
> {
  const registered = groups.filter((g) => g.registered);
  const unregistered = groups.filter((g) => !g.registered);

  const options: { value: string; label: string; hint?: string }[] = [];

  if (registered.length > 0) {
    for (const g of registered) {
      options.push({
        value: g.directory,
        label: `${pc.yellow("★")} ${pc.bold(g.displayName)} ${dim(tildeify(g.directory))}`,
        hint: formatHint(g),
      });
    }
  }

  if (unregistered.length > 0) {
    for (const g of unregistered) {
      options.push({
        value: g.directory,
        label: `  ${g.displayName} ${dim(tildeify(g.directory))}`,
        hint: formatHint(g),
      });
    }
  }

  options.push({
    value: "__add__",
    label: pc.green("+ Register a new project…"),
    hint: "save a directory under a short name",
  });

  if (registry.projects.length > 0) {
    options.push({
      value: "__remove__",
      label: pc.red("– Unregister a project (keep sessions)"),
    });
  }

  if (groups.length > 0) {
    options.push({
      value: "__purge__",
      label: pc.red("✗ Delete a project (purge all sessions)…"),
      hint: "clean up stale / dead project entries",
    });
  }

  if (sweepable.length > 0) {
    options.push({
      value: "__sweep__",
      label: pc.red(`🧹 Sweep clutter (${sweepable.length} hidden / stale)…`),
      hint: "auto-delete sessions in caches, ~/Downloads, /tmp, missing dirs",
    });
  }

  if (options.length === 1) {
    // Only the "Register" option — first run with nothing discovered.
    p.note(
      "No claude / codex / opencode sessions found yet.\n" +
        "Register a project to get started, or run one of the tools once.",
      "Empty",
    );
  }

  // Pre-select the cwd when it matches one of the listed projects.
  const cwd = process.cwd();
  const initial = groups.find((g) => g.directory === cwd)?.directory;

  const value = await toggleSelect({
    message: "Pick a project",
    options,
    ...(initial ? { initialValue: initial } : {}),
  });
  if (isCancel(value)) return CANCEL;
  if (value === "__add__") return "add";
  if (value === "__remove__") return "remove";
  if (value === "__purge__") return "purge";
  if (value === "__sweep__") return "sweep";

  const picked = groups.find((g) => g.directory === value);
  if (!picked) return CANCEL;
  return picked;
}

function formatHint(g: ProjectGroup): string | undefined {
  const counts: Record<string, number> = {};
  for (const s of g.sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
  const parts = Object.entries(counts).map(([t, n]) => `${t}·${n}`);
  const recency = g.latest ? timeAgo(g.latest) : "no sessions";
  if (parts.length === 0) return recency;
  return `${recency}  [${parts.join(", ")}]`;
}

async function sessionMenu(
  group: ProjectGroup,
  registry: Registry,
  defaults: MenuPickOptions,
): Promise<LaunchOptions | "back" | null> {
  // Determine starting toggle state for this project.
  const reg = group.registered;
  let skipPermissions = reg?.skipPermissions ?? defaults.skipPermissions;
  let newWindow = reg?.newWindow ?? defaults.newWindow;

  while (true) {
    const sessions = [...group.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );

    const options: { value: string; label: string; hint?: string }[] = [];

    for (const s of sessions) {
      const previewCmd = shellJoin(
        buildCommand({
          tool: s.tool,
          dir: group.directory,
          sessionId: s.id,
          skipPermissions: skipPermissions && toolSupportsSkipPermissions(s.tool),
          newWindow,
        }),
      );
      options.push({
        value: `resume:${s.tool}:${s.id}`,
        label: `${toolBadge(s.tool)}  ${truncate(s.title, 50)}`,
        hint: `${timeAgo(s.updatedAt)} · ${dim(previewCmd)}`,
      });
    }

    if (sessions.length > 0) {
      options.push({ value: "__sep__", label: dim("──────────────") });
    }

    for (const tool of ALL_TOOLS) {
      const previewCmd = shellJoin(
        buildCommand({
          tool,
          dir: group.directory,
          sessionId: null,
          skipPermissions: skipPermissions && toolSupportsSkipPermissions(tool),
          newWindow,
        }),
      );
      options.push({
        value: `new:${tool}`,
        label: `${pc.green("+")} New ${toolBadge(tool)} session`,
        hint: dim(previewCmd),
      });
    }

    options.push({ value: "__sep2__", label: dim("──────────────") });
    options.push({
      value: "__toggle_perm__",
      label: `${skipPermissions ? pc.red("⚠") : "·"} Skip permissions: ${
        skipPermissions ? pc.red("ON") : "off"
      }`,
      hint: skipPermissions ? "claude/codex run without prompts" : undefined,
    });
    options.push({
      value: "__toggle_window__",
      label: `${newWindow ? "▣" : "·"} New terminal window: ${
        newWindow ? pc.cyan("ON") : "off"
      }`,
    });
    if (sessions.length > 0) {
      options.push({
        value: "__delete__",
        label: pc.red("✂ Delete sessions…"),
        hint: "remove old or duplicate resumes from disk",
      });
      options.push({
        value: "__purge__",
        label: pc.red(`✗ Delete entire project (purge all ${sessions.length} session${sessions.length === 1 ? "" : "s"})`),
        hint: dirExists(group.directory)
          ? "wipes all on-disk sessions for this dir"
          : "directory no longer exists — safe to purge",
      });
    }
    if (reg) {
      options.push({
        value: "__save_defaults__",
        label: dim(`Save current toggles as ${reg.name}'s defaults`),
      });
    } else {
      options.push({
        value: "__register__",
        label: pc.green(`+ Register "${basename(group.directory)}" for quick access`),
      });
    }
    options.push({
      value: "__back__",
      label: "← Back",
      hint: "return to project picker",
    });

    const value = await toggleSelect({
      message: `${pc.bold(group.displayName)}  ${dim(tildeify(group.directory))}`,
      options: options.filter((o) => !o.value.startsWith("__sep")),
      spaceTogglesOn: (v) =>
        v === "__toggle_perm__" || v === "__toggle_window__",
    });

    if (isCancel(value)) return null;
    if (value === "__back__") return "back";

    if (value === "__toggle_perm__") {
      skipPermissions = !skipPermissions;
      continue;
    }
    if (value === "__toggle_window__") {
      newWindow = !newWindow;
      continue;
    }
    if (value === "__save_defaults__" && reg) {
      upsertProject(registry, {
        ...reg,
        skipPermissions,
        newWindow,
      });
      await saveRegistry(registry);
      p.note(`Saved defaults for ${reg.name}.`, "Updated");
      continue;
    }
    if (value === "__register__") {
      const result = await registerExisting(group, registry, {
        skipPermissions,
        newWindow,
      });
      if (result) {
        group.registered = result.project;
        group.displayName = result.project.name;
      }
      continue;
    }

    if (value === "__delete__") {
      await deleteSessionsFlow(group);
      continue;
    }

    if (value === "__purge__") {
      const purged = await purgeProjectInline(group, registry);
      if (purged) return "back";
      continue;
    }

    const [kind, tool, sessionId] = String(value).split(":") as [
      "resume" | "new",
      Tool,
      string | undefined,
    ];

    const launchOpts: LaunchOptions = {
      tool,
      dir: group.directory,
      sessionId: kind === "resume" ? sessionId! : null,
      skipPermissions:
        skipPermissions && toolSupportsSkipPermissions(tool),
      newWindow,
    };

    // Persist last-used for registered projects so `stash <name>` does the
    // right thing next time.
    if (group.registered) {
      recordLastSession(
        registry,
        group.directory,
        tool,
        launchOpts.sessionId,
      );
      await saveRegistry(registry);
    }

    // Show what we're about to do and confirm.
    const cmd = shellJoin(buildCommand(launchOpts));
    p.note(
      `${dim("cd")} ${tildeify(group.directory)}\n${cmd}`,
      newWindow ? "Will run in new terminal" : "Will run here",
    );

    return launchOpts;
  }
}

async function addProjectFlow(
  registry: Registry,
): Promise<{ registry: Registry; project: import("./types").RegisteredProject } | null> {
  const cwd = process.cwd();

  const dir = await p.text({
    message: "Project directory",
    initialValue: cwd,
    validate: (value) => {
      if (!value) return "Required";
      if (!existsSync(value)) return "Directory doesn't exist";
      try {
        const s = statSync(value);
        if (!s.isDirectory()) return "Not a directory";
      } catch {
        return "Cannot read directory";
      }
      return undefined;
    },
  });
  if (isCancel(dir)) return null;

  const defaultName = basename(dir as string);
  const name = await p.text({
    message: "Name (used as `stash <name>`)",
    initialValue: defaultName,
    validate: (v) => {
      if (!v) return "Required";
      if (!/^[A-Za-z0-9._-]+$/.test(v))
        return "Use letters, numbers, dot, dash, underscore";
      const clash = registry.projects.find(
        (p) => p.name.toLowerCase() === v.toLowerCase() && p.dir !== dir,
      );
      if (clash) return `Already used by ${clash.dir}`;
      return undefined;
    },
  });
  if (isCancel(name)) return null;

  const tool = await p.select({
    message: "Default CLI tool",
    options: [
      { value: "claude" as Tool, label: "claude" },
      { value: "codex" as Tool, label: "codex" },
      { value: "opencode" as Tool, label: "opencode" },
    ],
    initialValue: "claude" as Tool,
  });
  if (isCancel(tool)) return null;

  const skip = await p.confirm({
    message: "Skip permissions by default?",
    initialValue: false,
  });
  if (isCancel(skip)) return null;

  const win = await p.confirm({
    message: "Open in a new terminal window by default?",
    initialValue: true,
  });
  if (isCancel(win)) return null;

  const project = upsertProject(registry, {
    name: name as string,
    dir: dir as string,
    defaultTool: tool as Tool,
    skipPermissions: skip as boolean,
    newWindow: win as boolean,
  });
  await saveRegistry(registry);
  p.note(
    `${pc.green("✓")} Registered ${pc.bold(project.name)} → ${tildeify(project.dir)}`,
    "Added",
  );
  return { registry, project };
}

async function registerExisting(
  group: ProjectGroup,
  registry: Registry,
  defaults: { skipPermissions: boolean; newWindow: boolean },
): Promise<{ project: import("./types").RegisteredProject } | null> {
  const name = await p.text({
    message: "Short name",
    initialValue: basename(group.directory) || group.displayName,
    validate: (v) => {
      if (!v) return "Required";
      if (!/^[A-Za-z0-9._-]+$/.test(v))
        return "Use letters, numbers, dot, dash, underscore";
      const clash = registry.projects.find(
        (p) =>
          p.name.toLowerCase() === v.toLowerCase() && p.dir !== group.directory,
      );
      if (clash) return `Already used by ${clash.dir}`;
      return undefined;
    },
  });
  if (isCancel(name)) return null;

  const tool = await p.select({
    message: "Default CLI tool",
    options: ALL_TOOLS.map((t) => ({ value: t as Tool, label: t })),
    initialValue: (pickMostUsedTool(group.sessions) ?? "claude") as Tool,
  });
  if (isCancel(tool)) return null;

  const project = upsertProject(registry, {
    name: name as string,
    dir: group.directory,
    defaultTool: tool as Tool,
    skipPermissions: defaults.skipPermissions,
    newWindow: defaults.newWindow,
  });
  await saveRegistry(registry);
  p.note(
    `${pc.green("✓")} ${pc.bold(project.name)} registered → ${tildeify(project.dir)}`,
    "Saved",
  );
  return { project };
}

function pickMostUsedTool(sessions: Session[]): Tool | null {
  const counts: Record<string, number> = {};
  for (const s of sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
  let best: Tool | null = null;
  let n = 0;
  for (const [tool, c] of Object.entries(counts)) {
    if (c > n) {
      best = tool as Tool;
      n = c;
    }
  }
  return best;
}

async function removeProjectFlow(registry: Registry): Promise<void> {
  if (registry.projects.length === 0) {
    p.note("No registered projects.", "Nothing to remove");
    return;
  }
  const picked = await p.select({
    message: "Remove which project?",
    options: registry.projects.map((p) => ({
      value: p.name,
      label: `${p.name}  ${dim(tildeify(p.dir))}`,
    })),
  });
  if (isCancel(picked)) return;
  const ok = await p.confirm({
    message: `Remove "${picked}" from the registry? (Sessions on disk are not deleted.)`,
    initialValue: false,
  });
  if (isCancel(ok) || !ok) return;
  if (removeProject(registry, picked as string)) {
    await saveRegistry(registry);
    p.note(`Removed ${picked}.`, "Done");
  }
}

async function deleteSessionsFlow(group: ProjectGroup): Promise<void> {
  if (group.sessions.length === 0) {
    p.note("No sessions to delete in this project.", "Nothing to do");
    return;
  }

  const mode = await p.select({
    message: "What to delete?",
    options: [
      {
        value: "pick" as const,
        label: "Pick specific sessions…",
        hint: "multi-select from a checklist",
      },
      {
        value: "duplicates" as const,
        label: "Duplicates (same title, same tool)",
        hint: "keep only the most recent of each",
      },
      {
        value: "olderThan" as const,
        label: "Anything older than the most recent N…",
      },
    ],
  });
  if (isCancel(mode)) return;

  let toDelete: Session[] = [];

  if (mode === "pick") {
    const ordered = [...group.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const picked = await p.multiselect({
      message: "Select sessions to delete (space to toggle, enter to confirm)",
      required: false,
      options: ordered.map((s, i) => ({
        value: `${s.tool}:${s.id}`,
        label: `${toolBadge(s.tool)}  ${truncate(s.title, 50)}`,
        hint: `${timeAgo(s.updatedAt)}${i === 0 ? "  (most recent)" : ""}`,
      })),
    });
    if (isCancel(picked) || !Array.isArray(picked) || picked.length === 0) return;
    const set = new Set(picked as string[]);
    toDelete = ordered.filter((s) => set.has(`${s.tool}:${s.id}`));
  } else if (mode === "duplicates") {
    const dups = findDuplicateSessions(group.sessions);
    if (dups.length === 0) {
      p.note("No duplicate titles in this project.", "Nothing to do");
      return;
    }
    // Each `dups[]` is sorted newest first — keep [0], delete the rest.
    for (const dup of dups) toDelete.push(...dup.slice(1));
    const preview = dups
      .map((d) => {
        const head = `${toolBadge(d[0]!.tool)}  ${truncate(d[0]!.title, 50)}`;
        return `keep  ${head}  ${dim(timeAgo(d[0]!.updatedAt))}\n` +
          d
            .slice(1)
            .map(
              (s) =>
                `  ${pc.red("delete")}  ${toolBadge(s.tool)}  ${truncate(s.title, 50)}  ${dim(
                  timeAgo(s.updatedAt),
                )}`,
            )
            .join("\n");
      })
      .join("\n\n");
    p.note(preview, `${toDelete.length} duplicate session(s)`);
  } else if (mode === "olderThan") {
    const ordered = [...group.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const nStr = await p.text({
      message: `Keep how many most-recent sessions? (have ${ordered.length})`,
      initialValue: "5",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return "Enter a non-negative integer";
        if (n >= ordered.length) return "That would delete nothing";
        return undefined;
      },
    });
    if (isCancel(nStr)) return;
    const n = Number(nStr);
    toDelete = ordered.slice(n);
    const preview =
      ordered
        .slice(0, n)
        .map(
          (s) =>
            `keep    ${toolBadge(s.tool)}  ${truncate(s.title, 50)}  ${dim(
              timeAgo(s.updatedAt),
            )}`,
        )
        .join("\n") +
      "\n" +
      toDelete
        .map(
          (s) =>
            `${pc.red("delete")}  ${toolBadge(s.tool)}  ${truncate(s.title, 50)}  ${dim(
              timeAgo(s.updatedAt),
            )}`,
        )
        .join("\n");
    p.note(preview, `Will delete ${toDelete.length} session(s)`);
  }

  if (toDelete.length === 0) {
    p.note("Nothing matched.", "Done");
    return;
  }

  const ok = await p.confirm({
    message: `Permanently delete ${toDelete.length} session(s) from disk?`,
    initialValue: false,
  });
  if (isCancel(ok) || !ok) return;

  const sp = p.spinner();
  sp.start("Deleting…");
  const results = await deleteSessions(toDelete);
  sp.stop();

  const ok_count = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    p.note(`${pc.green("✓")} removed ${ok_count} session(s)`, "Deleted");
  } else {
    const lines = failures
      .map((f) => `  ${f.session.tool}:${f.session.id.slice(0, 8)} — ${f.error}`)
      .join("\n");
    p.note(
      `${pc.green("✓")} removed ${ok_count} session(s)\n${pc.red("✗")} failed ${failures.length}:\n${lines}`,
      "Done with errors",
    );
  }

  // Remove the deleted sessions from the in-memory group so the menu
  // refreshes without rerunning discovery.
  const deletedIds = new Set(
    results.filter((r) => r.ok).map((r) => `${r.session.tool}:${r.session.id}`),
  );
  group.sessions = group.sessions.filter(
    (s) => !deletedIds.has(`${s.tool}:${s.id}`),
  );
}

function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Confirm + delete every session attached to `group.directory` across all
 *  three tools. Returns true on a successful purge. */
async function purgeProjectInline(
  group: ProjectGroup,
  registry: Registry,
): Promise<boolean> {
  const total = group.sessions.length;
  if (total === 0) {
    p.note("Nothing to purge.", "Empty");
    return false;
  }
  const counts: Record<string, number> = {};
  for (const s of group.sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
  const breakdown = Object.entries(counts)
    .map(([t, n]) => `${toolBadge(t)}·${n}`)
    .join("  ");
  const exists = dirExists(group.directory);
  const lines = [
    `${pc.bold(group.displayName)}  ${dim(tildeify(group.directory))}`,
    "",
    `Sessions to delete: ${breakdown}`,
    "",
    exists
      ? pc.dim("The on-disk project directory is left alone — only session files / DB rows are removed.")
      : pc.yellow("The on-disk project directory no longer exists. Safe to purge."),
  ];
  p.note(lines.join("\n"), `Purge ${total} session(s)?`);

  const confirm = await p.text({
    message: `Type "${pc.bold(group.displayName)}" to confirm (empty to cancel)`,
    initialValue: "",
    validate: (v) => {
      if (!v) return undefined;
      if (v !== group.displayName) return `Doesn't match "${group.displayName}"`;
      return undefined;
    },
  });
  if (isCancel(confirm) || !confirm) {
    p.cancel("Purge cancelled.");
    return false;
  }

  const sp = p.spinner();
  sp.start(`Deleting ${total} session(s)…`);
  const results = await deleteSessions(group.sessions);
  sp.stop();

  const ok = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok);
  if (fails.length === 0) {
    p.note(`${pc.green("✓")} purged ${ok} session(s)`, "Done");
  } else {
    p.note(
      `${pc.green("✓")} purged ${ok}\n${pc.red("✗")} failed ${fails.length}:\n` +
        fails
          .map((f) => `  ${f.session.tool}:${f.session.id.slice(0, 8)} — ${f.error}`)
          .join("\n"),
      "Done with errors",
    );
  }

  // Also drop the registry entry, since the project is now empty.
  if (group.registered) {
    if (removeProject(registry, group.registered.name)) {
      await saveRegistry(registry);
    }
  }

  return true;
}

/** Project-picker entry point: lets the user choose any discovered project
 *  (registered or not) to purge. Returns true if anything was deleted. */
async function purgeProjectFlow(
  groups: ProjectGroup[],
): Promise<boolean> {
  if (groups.length === 0) {
    p.note("No projects discovered.", "Nothing to do");
    return false;
  }
  const sorted = [...groups].sort((a, b) => b.latest - a.latest);
  const picked = await toggleSelect({
    message: "Delete which project's sessions?",
    options: [
      ...sorted.map((g) => {
        const exists = dirExists(g.directory);
        const status = exists ? "" : pc.yellow(" [missing]");
        const counts: Record<string, number> = {};
        for (const s of g.sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
        const breakdown = Object.entries(counts)
          .map(([t, n]) => `${t}·${n}`)
          .join(", ");
        return {
          value: g.directory,
          label: `${g.displayName} ${dim(tildeify(g.directory))}${status}`,
          hint: `${g.sessions.length} sessions [${breakdown}] · ${
            g.latest ? timeAgo(g.latest) : "no activity"
          }`,
        };
      }),
      { value: "__cancel__", label: dim("← Cancel") },
    ],
  });
  if (isCancel(picked) || picked === "__cancel__") return false;

  const group = groups.find((g) => g.directory === picked);
  if (!group) return false;

  // Load registry fresh so we can drop the matching entry.
  const reg = await loadRegistry();
  return await purgeProjectInline(group, reg);
}

async function sweepClutterFlow(targets: ProjectGroup[]): Promise<boolean> {
  if (targets.length === 0) {
    p.note("Nothing to sweep.", "Clean");
    return false;
  }

  let totalSessions = 0;
  for (const g of targets) totalSessions += g.sessions.length;

  const preview = targets
    .slice()
    .sort((a, b) => b.latest - a.latest)
    .map((g) => {
      const counts: Record<string, number> = {};
      for (const s of g.sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
      const breakdown = Object.entries(counts)
        .map(([t, n]) => `${t}·${n}`)
        .join(", ");
      const reason = clutterReason(g);
      return `${pc.red("delete")}  ${g.displayName} ${dim(tildeify(g.directory))}  ${dim(
        `[${breakdown}] ${reason}`,
      )}`;
    })
    .join("\n");

  p.note(preview, `Sweep ${targets.length} project(s) / ${totalSessions} session(s)`);

  const confirm = await p.confirm({
    message: `Permanently delete ${totalSessions} session(s) across ${targets.length} stale project(s)?`,
    initialValue: false,
  });
  if (isCancel(confirm) || !confirm) return false;

  const all: Session[] = [];
  for (const g of targets) all.push(...g.sessions);

  const sp = p.spinner();
  sp.start(`Sweeping ${all.length} session(s)…`);
  const results = await deleteSessions(all);
  sp.stop();

  const ok = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok);
  if (fails.length === 0) {
    p.note(`${pc.green("✓")} swept ${ok} session(s)`, "Done");
  } else {
    p.note(
      `${pc.green("✓")} swept ${ok}\n${pc.red("✗")} failed ${fails.length}:\n` +
        fails
          .slice(0, 10)
          .map((f) => `  ${f.session.tool}:${f.session.id.slice(0, 8)} — ${f.error}`)
          .join("\n") +
        (fails.length > 10 ? `\n  …and ${fails.length - 10} more` : ""),
      "Done with errors",
    );
  }
  return true;
}


