export type Tool = "claude" | "codex" | "opencode";

export const ALL_TOOLS: Tool[] = ["claude", "codex", "opencode"];

export interface Session {
  tool: Tool;
  id: string;
  title: string;
  directory: string;
  updatedAt: number;
}

export interface ProjectGroup {
  directory: string;
  displayName: string;
  sessions: Session[];
  registered: RegisteredProject | null;
  latest: number;
}

export interface RegisteredProject {
  name: string;
  dir: string;
  defaultTool: Tool;
  skipPermissions: boolean;
  newWindow: boolean;
  lastSessionId?: string;
  lastTool?: Tool;
  addedAt: string;
  updatedAt: string;
}

export interface Registry {
  version: 1;
  projects: RegisteredProject[];
}

export interface LaunchOptions {
  tool: Tool;
  dir: string;
  sessionId: string | null;
  skipPermissions: boolean;
  newWindow: boolean;
}
