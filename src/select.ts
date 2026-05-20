import { SelectPrompt } from "@clack/core";
import pc from "picocolors";

export interface SelectOption<T> {
  value: T;
  label?: string;
  hint?: string;
}

export interface ToggleSelectArgs<T> {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
  /** Visible at the top of the menu, shown above the message line. */
  banner?: string;
  /**
   * Return `true` for option values that should also accept SPACE as a submit
   * trigger (i.e. inline toggles). When the cursor is on such a row, pressing
   * space behaves exactly like pressing enter. Non-toggle rows ignore space.
   */
  spaceTogglesOn?: (value: T) => boolean;
}

const BAR = pc.gray("│");
const BAR_ACTIVE = pc.cyan("│");
const BAR_END = pc.gray("└");
const ACTIVE_DOT = pc.green("●");
const INACTIVE_DOT = pc.dim("○");

function stateSymbol(state: string): string {
  switch (state) {
    case "initial":
    case "active":
      return pc.cyan("◆");
    case "cancel":
      return pc.red("■");
    case "error":
      return pc.yellow("▲");
    case "submit":
      return pc.green("◇");
    default:
      return pc.cyan("◆");
  }
}

function renderOption<T>(
  o: SelectOption<T>,
  mode: "active" | "inactive" | "selected" | "cancelled",
): string {
  const label = o.label ?? String(o.value);
  switch (mode) {
    case "active":
      return `${ACTIVE_DOT} ${label}${o.hint ? " " + pc.dim(`(${o.hint})`) : ""}`;
    case "selected":
      return pc.dim(label);
    case "cancelled":
      return pc.strikethrough(pc.dim(label));
    case "inactive":
    default:
      return `${INACTIVE_DOT} ${pc.dim(label)}`;
  }
}

/**
 * A `select` that mirrors @clack/prompts visually but also fires "submit" when
 * the user hits SPACE while on a row that `spaceTogglesOn` returns true for.
 *
 * The base class wires the up/down/left/right keys, refreshes the prompt
 * `value` whenever the cursor moves, and routes SPACE through the same
 * `cursor` event channel — we just need to listen for it and flip the state.
 */
export async function toggleSelect<T>(
  args: ToggleSelectArgs<T>,
): Promise<T | symbol> {
  const prompt = new SelectPrompt<SelectOption<T>>({
    options: args.options,
    initialValue: args.initialValue,
    render() {
      const head = args.banner
        ? `${BAR}\n${args.banner}\n`
        : `${BAR}\n`;
      const messageLine = `${stateSymbol(this.state)}  ${args.message}\n`;

      switch (this.state) {
        case "submit":
          return (
            head +
            messageLine +
            `${BAR}  ${renderOption(this.options[this.cursor]!, "selected")}`
          );
        case "cancel":
          return (
            head +
            messageLine +
            `${BAR}  ${renderOption(this.options[this.cursor]!, "cancelled")}\n${BAR}`
          );
        default: {
          const rows = this.options
            .map((o, i) =>
              renderOption(o, i === this.cursor ? "active" : "inactive"),
            )
            .join(`\n${BAR_ACTIVE}  `);
          const footer = `${BAR_ACTIVE}\n${BAR_ACTIVE}  ${pc.dim("↑↓ navigate · enter select · space toggle · ctrl+c exit")}`;
          return head + messageLine + `${BAR_ACTIVE}  ${rows}\n${footer}\n${BAR_END}`;
        }
      }
    },
  });

  // SPACE comes through as a `cursor` event with the literal direction
  // "space". When the focused row is a toggle, treat it as ENTER.
  prompt.on("cursor", (dir: string) => {
    if (dir !== "space") return;
    const opt = prompt.options[prompt.cursor];
    if (!opt) return;
    if (args.spaceTogglesOn?.(opt.value)) {
      // SelectPrompt keeps `value` synced to the current cursor position, so
      // we just flip the state to "submit". The base Prompt machinery will
      // call render() and then close(), emitting the value on resolution.
      prompt.state = "submit";
    }
  });

  return (await prompt.prompt()) as T | symbol;
}
