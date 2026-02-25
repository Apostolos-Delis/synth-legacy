import { join, basename } from "node:path";
import type { SynthConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath } from "./paths.js";
import { readTomlFile } from "./writer.js";
import { getLogger } from "../logging/logger.js";

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
  const resolvedGlobalPath = globalPath ?? globalConfigPath();
  const projectPath = join(cwd, "synth.toml");
  const globalConfig = await readTomlFile(resolvedGlobalPath);
  const fileConfig = await readTomlFile(projectPath);

  let config: SynthConfig = deepMerge(DEFAULT_CONFIG, globalConfig);
  config = deepMerge(config, fileConfig);
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // Auto-detect project name from directory if not set
  if (!config.project.name) {
    config.project.name = basename(cwd) || "unknown";
  }

  const log = getLogger();

  log.info("config:loaded", `Config loaded for ${config.project.name}`, {
    globalPath: resolvedGlobalPath,
    projectPath,
    hasOverrides: overrides !== undefined,
  });

  if (config.execution.max_iterations <= 0) {
    log.warn("config:validation-warning", "max_iterations is non-positive", {
      value: config.execution.max_iterations,
    });
  }
  if (config.agent.timeout <= 0) {
    log.warn("config:validation-warning", "agent timeout is non-positive", {
      value: config.agent.timeout,
    });
  }
  if (!config.project.name || config.project.name === "unknown") {
    log.warn("config:validation-warning", "project name could not be determined", {
      fallback: config.project.name,
    });
  }

  return config;
}
