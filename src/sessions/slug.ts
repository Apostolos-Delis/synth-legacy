import { join } from "node:path";
import { readJson } from "../utils/fs.js";
import type { SessionPaths, SessionMetadata } from "./types.js";

export async function getSessionSlug(sessionPaths: SessionPaths): Promise<string> {
  try {
    const meta = await readJson<SessionMetadata>(join(sessionPaths.root, "metadata.json"));
    return meta?.slug || "synth";
  } catch {
    return "synth";
  }
}

const FILLER_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "be", "been",
  "add", "implement", "create", "update", "build", "setup", "set", "up",
  "make", "write", "develop", "introduce", "enable", "support", "handle",
  "integrate", "configure", "refactor", "fix", "remove", "delete",
]);

const SLUG_MAX_LENGTH = 30;

export function deriveSessionSlug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w));

  if (words.length === 0) return "session";

  let slug = words.join("-");
  if (slug.length > SLUG_MAX_LENGTH) {
    // Truncate at a word boundary
    slug = slug.slice(0, SLUG_MAX_LENGTH);
    const lastDash = slug.lastIndexOf("-");
    if (lastDash > 0) slug = slug.slice(0, lastDash);
  }

  return slug || "session";
}

export function deriveTaskPrefix(title: string): string {
  const words = title
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return "TASK";

  // If there's an all-uppercase word (acronym) of 2-5 chars, use it
  const acronym = words.find((w) => /^[A-Z]{2,5}$/.test(w));
  if (acronym) return acronym;

  // Use the last significant word (typically the noun), uppercased, truncated to 4 chars
  const lastWord = words[words.length - 1].toUpperCase().slice(0, 4);
  if (lastWord.length >= 2) return lastWord;

  // Fallback: first letters of significant words
  const initials = words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  return initials.length >= 2 ? initials : "TASK";
}
