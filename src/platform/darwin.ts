import { spawn, execSync } from "node:child_process";
import type { PlatformProvider, SleepInhibitor } from "./types.js";

const NO_OP_INHIBITOR: SleepInhibitor = { release() {} };

export class DarwinPlatform implements PlatformProvider {
  readonly name = "darwin";

  inhibitSleep(_reason: string): SleepInhibitor {
    let released = false;
    try {
      const proc = spawn("caffeinate", ["-i"], {
        stdio: "ignore",
        detached: true,
      });
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
    return new Promise((resolve) => {
      const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
      proc.stdin.end(text);
    });
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
    return `brew install ${tool}`;
  }
}
