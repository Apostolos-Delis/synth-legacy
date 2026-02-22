import { join } from "node:path";
import { fileExists } from "../utils/fs.js";
import { spawn } from "../utils/process.js";

interface Formatter {
  name: string;
  command: string[];
  detectFile: string;
}

const FORMATTERS: Formatter[] = [
  {
    name: "prettier",
    command: ["npx", "prettier", "--write", "."],
    detectFile: ".prettierrc",
  },
  {
    name: "prettier (config)",
    command: ["npx", "prettier", "--write", "."],
    detectFile: ".prettierrc.json",
  },
  {
    name: "biome",
    command: ["npx", "@biomejs/biome", "format", "--write", "."],
    detectFile: "biome.json",
  },
  {
    name: "black",
    command: ["black", "."],
    detectFile: "pyproject.toml",
  },
  {
    name: "rubocop",
    command: ["rubocop", "-a"],
    detectFile: ".rubocop.yml",
  },
];

export async function detectFormatters(
  cwd: string,
): Promise<Formatter[]> {
  const found: Formatter[] = [];
  for (const fmt of FORMATTERS) {
    if (await fileExists(join(cwd, fmt.detectFile))) {
      found.push(fmt);
    }
  }
  // Also check package.json for format script
  const pkgPath = join(cwd, "package.json");
  if (await fileExists(pkgPath)) {
    const pkg = await Bun.file(pkgPath).json();
    if (pkg.scripts?.format) {
      found.push({
        name: "npm format",
        command: ["npm", "run", "format"],
        detectFile: "package.json",
      });
    }
  }
  return found;
}

export async function runFormatters(
  cwd: string,
): Promise<{ name: string; success: boolean }[]> {
  const formatters = await detectFormatters(cwd);
  const results: { name: string; success: boolean }[] = [];

  for (const fmt of formatters) {
    const handle = spawn({ cmd: fmt.command, cwd });
    const result = await handle.promise;
    results.push({ name: fmt.name, success: result.exitCode === 0 });
    // Run only the first matching formatter
    break;
  }

  return results;
}
