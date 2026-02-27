import { spawn, execSync, spawnSync } from "node:child_process";
import type { PlatformProvider, SleepInhibitor } from "./types.js";

const NO_OP_INHIBITOR: SleepInhibitor = { release() {} };

function commandExists(cmd: string): boolean {
  try {
    return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export class LinuxPlatform implements PlatformProvider {
  readonly name = "linux";

  inhibitSleep(reason: string): SleepInhibitor {
    if (!commandExists("systemd-inhibit")) return NO_OP_INHIBITOR;

    let released = false;
    try {
      const proc = spawn(
        "systemd-inhibit",
        ["--what=idle:sleep", `--reason=${reason}`, "sleep", "infinity"],
        { stdio: "ignore", detached: true },
      );
      proc.unref();
      return {
        release() {
          if (released) return;
          released = true;
          try { proc.kill(); } catch { /* already exited */ }
        },
      };
    } catch {
      return NO_OP_INHIBITOR;
    }
  }

  copyToClipboard(text: string): Promise<boolean> {
    const candidates: { bin: string; args: string[] }[] = [
      { bin: "xclip", args: ["-selection", "clipboard"] },
      { bin: "xsel", args: ["--clipboard"] },
      { bin: "wl-copy", args: [] },
    ];

    for (const { bin, args } of candidates) {
      if (!commandExists(bin)) continue;
      return new Promise((resolve) => {
        const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
        proc.stdin.end(text);
      });
    }

    return Promise.resolve(false);
  }

  async getAvailableDiskMb(path: string): Promise<number> {
    try {
      const output = execSync(`df -m ${JSON.stringify(path)}`, { encoding: "utf-8", timeout: 5_000 });
      const lines = output.trim().split("\n");
      if (lines.length < 2) return Infinity;
      const columns = lines[1].split(/\s+/);
      const available = parseInt(columns[3], 10);
      return isNaN(available) ? Infinity : available;
    } catch {
      return Infinity;
    }
  }

  defaultEditor(): string {
    return "vi";
  }

  installHint(tool: string): string {
    if (commandExists("apt")) return `sudo apt install ${tool}`;
    if (commandExists("dnf")) return `sudo dnf install ${tool}`;
    if (commandExists("brew")) return `brew install ${tool}`;
    return `Install ${tool} using your package manager`;
  }
}
