import { appendFile, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  return (await file.json()) as T;
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

export async function readText(path: string): Promise<string> {
  const file = Bun.file(path);
  return await file.text();
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await Bun.write(path, content);
}

export async function appendText(
  path: string,
  content: string,
): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, content);
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // File doesn't exist — nothing to remove
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
