import { join } from "node:path";
import { homedir } from "node:os";
import Handlebars from "handlebars";
import { fileExists, readText } from "../utils/fs.js";
import { getBuiltinTemplate, getBuiltinTemplateOrDefault } from "./builtin.js";
import type {
  TemplatePhase,
  TemplateVariables,
  TemplateLoadResult,
  TemplateRenderResult,
} from "./types.js";

const compiledCache = new Map<string, HandlebarsTemplateDelegate>();

function compile(template: string): HandlebarsTemplateDelegate {
  const cached = compiledCache.get(template);
  if (cached) return cached;
  const compiled = Handlebars.compile(template, { noEscape: true });
  compiledCache.set(template, compiled);
  return compiled;
}

export interface LoadTemplateOptions {
  explicitPath?: string;
  homeDir?: string;
  phase?: TemplatePhase;
}

export async function loadTemplate(
  agentName: string,
  cwd: string,
  explicitPathOrOptions?: string | LoadTemplateOptions,
): Promise<TemplateLoadResult> {
  const opts: LoadTemplateOptions =
    typeof explicitPathOrOptions === "string"
      ? { explicitPath: explicitPathOrOptions }
      : explicitPathOrOptions ?? {};

  const { phase } = opts;

  // 1. Explicit path override (from config)
  if (opts.explicitPath) {
    if (await fileExists(opts.explicitPath)) {
      return {
        source: "explicit",
        path: opts.explicitPath,
        template: await readText(opts.explicitPath),
      };
    }
  }

  const home = opts.homeDir ?? homedir();

  // 2. Phase-aware filesystem lookup (when phase is specified)
  if (phase) {
    // 2a. Project-level: ./synth-templates/{phase}/{agent}.hbs
    const phasedProjectPath = join(cwd, "synth-templates", phase, `${agentName}.hbs`);
    if (await fileExists(phasedProjectPath)) {
      return {
        source: "project",
        path: phasedProjectPath,
        template: await readText(phasedProjectPath),
      };
    }

    // 2b. Global: ~/.synth/templates/{phase}/{agent}.hbs
    const phasedGlobalPath = join(home, ".synth", "templates", phase, `${agentName}.hbs`);
    if (await fileExists(phasedGlobalPath)) {
      return {
        source: "global",
        path: phasedGlobalPath,
        template: await readText(phasedGlobalPath),
      };
    }
  }

  // 3. Legacy (un-phased) filesystem lookup
  // ./synth-templates/{agent}.hbs
  const projectPath = join(cwd, "synth-templates", `${agentName}.hbs`);
  if (await fileExists(projectPath)) {
    return {
      source: "project",
      path: projectPath,
      template: await readText(projectPath),
    };
  }

  // ~/.synth/templates/{agent}.hbs
  const globalPath = join(home, ".synth", "templates", `${agentName}.hbs`);
  if (await fileExists(globalPath)) {
    return {
      source: "global",
      path: globalPath,
      template: await readText(globalPath),
    };
  }

  // 4. Built-in lookup: {phase}/{agent} → {phase}/default → legacy {agent} → legacy default
  if (phase) {
    const phasedKey = `${phase}/${agentName}`;
    const phasedBuiltin = getBuiltinTemplate(phasedKey);
    if (phasedBuiltin) {
      return { source: "builtin", template: phasedBuiltin };
    }

    const phasedDefault = getBuiltinTemplate(`${phase}/default`);
    if (phasedDefault) {
      return { source: "builtin-default", template: phasedDefault };
    }
  }

  // 5. Legacy built-in for this agent
  const builtin = getBuiltinTemplate(agentName);
  if (builtin) {
    return { source: "builtin", template: builtin };
  }

  // 6. Default built-in fallback
  return {
    source: "builtin-default",
    template: getBuiltinTemplateOrDefault(agentName),
  };
}

export function renderTemplate(
  loadResult: TemplateLoadResult,
  variables: TemplateVariables,
): TemplateRenderResult {
  try {
    const compiled = compile(loadResult.template);
    return {
      rendered: compiled(variables),
      source: loadResult.source,
      path: loadResult.path,
    };
  } catch {
    // Malformed template — fall back to raw content so the agent still gets instructions
    return {
      rendered: loadResult.template,
      source: loadResult.source,
      path: loadResult.path,
    };
  }
}
