import { join, basename } from "node:path";
import type { SynthConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath } from "./paths.js";
import { readTomlFile } from "./writer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export async function loadConfig(
  cwd: string,
  overrides?: Partial<SynthConfig>,
  globalPath?: string,
): Promise<SynthConfig> {
  const globalConfig = await readTomlFile(globalPath ?? globalConfigPath());
  const fileConfig = await readTomlFile(join(cwd, "synth.toml"));

  let config: SynthConfig = deepMerge(DEFAULT_CONFIG, globalConfig);
  config = deepMerge(config, fileConfig);
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // Auto-detect project name from directory if not set
  if (!config.project.name) {
    config.project.name = basename(cwd) || "unknown";
  }

  return config;
}
