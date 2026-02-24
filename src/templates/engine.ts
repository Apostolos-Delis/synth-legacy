import { join } from "node:path";
import { homedir } from "node:os";
import Handlebars from "handlebars";
import { fileExists, readText } from "../utils/fs.js";
import { getBuiltinTemplate, getBuiltinTemplateOrDefault } from "./builtin.js";
import type {
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

  // 2. Project-level: ./synth-templates/{agent}.hbs
  const projectPath = join(cwd, "synth-templates", `${agentName}.hbs`);
  if (await fileExists(projectPath)) {
    return {
      source: "project",
      path: projectPath,
      template: await readText(projectPath),
    };
  }

  // 3. Global: ~/.synth/templates/{agent}.hbs
  const home = opts.homeDir ?? homedir();
  const globalPath = join(home, ".synth", "templates", `${agentName}.hbs`);
  if (await fileExists(globalPath)) {
    return {
      source: "global",
      path: globalPath,
      template: await readText(globalPath),
    };
  }

  // 4. Built-in for this agent
  const builtin = getBuiltinTemplate(agentName);
  if (builtin) {
    return { source: "builtin", template: builtin };
  }

  // 5. Default built-in fallback
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
