import { mkdir } from "node:fs/promises";
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
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(path, existing + content);
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}
