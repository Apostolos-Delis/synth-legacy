import { parse, stringify } from "smol-toml";
import { fileExists, readText, writeText } from "../utils/fs.js";
import { DEFAULT_CONFIG } from "./defaults.js";

export async function readTomlFile(
  path: string,
): Promise<Record<string, unknown>> {
  if (!(await fileExists(path))) {
    return {};
  }
  const raw = await readText(path);
  return parse(raw) as Record<string, unknown>;
}

export async function writeTomlFile(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const toml = stringify(data);
  await writeText(path, toml);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lookupDefault(dottedKey: string): { value: any; found: boolean } {
  const segments = dottedKey.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = DEFAULT_CONFIG;
  for (const seg of segments) {
    if (current == null || typeof current !== "object" || !(seg in current)) {
      return { value: undefined, found: false };
    }
    current = current[seg];
  }
  return { value: current, found: true };
}

function setNestedKey(
  obj: Record<string, unknown>,
  segments: string[],
  value: unknown,
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (
      current[seg] == null ||
      typeof current[seg] !== "object" ||
      Array.isArray(current[seg])
    ) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

export async function setConfigValue(
  filePath: string,
  dottedKey: string,
  value: unknown,
): Promise<void> {
  const { value: defaultValue, found } = lookupDefault(dottedKey);
  if (!found) {
    throw new Error(`unknown config key: '${dottedKey}'`);
  }

  const expectedType = Array.isArray(defaultValue)
    ? "array"
    : typeof defaultValue;
  const actualType = Array.isArray(value) ? "array" : typeof value;

  if (expectedType !== actualType) {
    throw new Error(
      `expected ${expectedType} for ${dottedKey}, got ${JSON.stringify(value)}`,
    );
  }

  const data = await readTomlFile(filePath);
  setNestedKey(data, dottedKey.split("."), value);
  await writeTomlFile(filePath, data);
}
