import type { PlatformProvider, SleepInhibitor } from "./types.js";

const NO_OP_INHIBITOR: SleepInhibitor = { release() {} };

export class DefaultPlatform implements PlatformProvider {
  readonly name = "default";

  inhibitSleep(): SleepInhibitor {
    return NO_OP_INHIBITOR;
  }

  copyToClipboard(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async getAvailableDiskMb(): Promise<number> {
    return Infinity;
  }

  defaultEditor(): string {
    return process.platform === "win32" ? "notepad" : "vi";
  }

  installHint(tool: string): string {
    return `Install ${tool} using your package manager`;
  }
}
