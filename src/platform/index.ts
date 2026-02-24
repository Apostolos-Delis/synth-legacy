import { DarwinPlatform } from "./darwin.js";
import { LinuxPlatform } from "./linux.js";
import { DefaultPlatform } from "./default.js";
import type { PlatformProvider } from "./types.js";

export type { PlatformProvider, SleepInhibitor } from "./types.js";

let cached: PlatformProvider | undefined;

export function getPlatform(): PlatformProvider {
  if (!cached) {
    switch (process.platform) {
      case "darwin": cached = new DarwinPlatform(); break;
      case "linux":  cached = new LinuxPlatform(); break;
      default:       cached = new DefaultPlatform(); break;
    }
  }
  return cached;
}
