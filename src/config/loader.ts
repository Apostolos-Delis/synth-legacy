import { join, basename } from "node:path";
import type { SynthConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { globalConfigPath } from "./paths.js";
import { readTomlFile } from "./writer.js";
import { getLogger } from "../logging/logger.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    const baseValue = base[key];
    if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
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
    config = deepMerge(config, overrides as Record<string, unknown>);
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
