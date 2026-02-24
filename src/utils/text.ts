const AFFIRMATIVE_PHRASES = new Set([
  "yes",
  "y",
  "ok",
  "okay",
  "looks good",
  "lgtm",
  "execute",
  "let's go",
  "lets go",
  "confirm",
  "approve",
  "approved",
  "start",
  "proceed",
  "finish",
  "done",
  "go",
  "ship it",
  "ship",
  "good",
  "great",
  "perfect",
  "yep",
  "yup",
  "sure",
  "sounds good",
]);

export function isAffirmative(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return AFFIRMATIVE_PHRASES.has(normalized);
}
