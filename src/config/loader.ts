import { parse } from "smol-toml";
import { join } from "node:path";
import type { SynthConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { fileExists, readText } from "../utils/fs.js";

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
): Promise<SynthConfig> {
  const configPath = join(cwd, "synth.toml");
  let fileConfig: Record<string, unknown> = {};

  if (await fileExists(configPath)) {
    const raw = await readText(configPath);
    fileConfig = parse(raw) as Record<string, unknown>;
  }

  let config: SynthConfig = deepMerge(DEFAULT_CONFIG, fileConfig);
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // Auto-detect project name from directory if not set
  if (!config.project.name) {
    config.project.name = cwd.split("/").pop() ?? "unknown";
  }

  return config;
}
