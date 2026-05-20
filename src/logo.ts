import pc from "picocolors";

// Compact box-drawing banner. We can't use String.raw here — Bun's
// implementation rewrites non-ASCII chars in the raw segment into
// JavaScript-style \uXXXX escape sequences, which then print literally.
const ART = [
  "  ┏━┓╺┳╸┏━┓┏━┓╻ ╻",
  "  ┗━┓ ┃ ┣━┫┗━┓┣━┫",
  "  ┗━┛ ╹ ╹ ╹┗━┛╹ ╹",
].join("\n");

/** Print the banner once on launch. Bails silently when output isn't a TTY,
 *  the terminal is too narrow, or NO_COLOR / NO_BANNER is set. */
export function printLogo(): void {
  if (process.env["NO_BANNER"]) return;
  if (!process.stdout.isTTY) return;
  if ((process.stdout.columns ?? 80) < 28) return;

  const lines = ART.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    console.log(pc.magenta(line));
  }
  console.log(
    "  " +
      pc.dim("resume across ") +
      pc.magenta("claude") +
      pc.dim(" · ") +
      pc.cyan("codex") +
      pc.dim(" · ") +
      pc.yellow("opencode"),
  );
}
