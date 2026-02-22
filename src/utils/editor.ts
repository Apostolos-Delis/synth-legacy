import { mkdtemp, unlink, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Open content in the user's preferred external editor.
 * Returns the edited text on success, or null on error/non-zero exit.
 */
export async function openInEditor(content: string): Promise<string | null> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = await mkdtemp(join(tmpdir(), "synth-edit-"));
  const tmpFile = join(dir, "SYNTH_PROMPT.md");

  try {
    await writeFile(tmpFile, content, "utf-8");

    const parts = editor.split(/\s+/);
    const proc = Bun.spawn([...parts, tmpFile], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null;

    return await readFile(tmpFile, "utf-8");
  } catch {
    return null;
  } finally {
    try { await unlink(tmpFile); } catch { /* already gone */ }
    try { const { rmdir } = await import("node:fs/promises"); await rmdir(dir); } catch { /* best effort */ }
  }
}
