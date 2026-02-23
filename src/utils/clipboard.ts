import { spawn } from "child_process";

/**
 * Copy text to the system clipboard.
 * Uses pbcopy on macOS, xclip or xsel on Linux.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin"
      ? { bin: "pbcopy", args: [] as string[] }
      : { bin: "xclip", args: ["-selection", "clipboard"] };

  return new Promise((resolve) => {
    const proc = spawn(cmd.bin, cmd.args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin.end(text);
  });
}
