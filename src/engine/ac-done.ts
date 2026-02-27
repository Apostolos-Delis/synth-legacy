export const AC_DONE_PATTERN = /<ac-done>(\d+)<\/ac-done>/g;

const AC_DONE_FAST_CHECK = "<ac-done>";
const AC_DONE_PARSE_RE = /<ac-done>(\d+)<\/ac-done>/g;
const AC_DONE_STRIP_RE = /<ac-done>[^<]*<\/ac-done>/g;

export function parseAcDoneMarkers(text: string): number[] {
  if (!text.includes(AC_DONE_FAST_CHECK)) return [];
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  AC_DONE_PARSE_RE.lastIndex = 0;
  while ((match = AC_DONE_PARSE_RE.exec(text)) !== null) {
    indices.push(Number(match[1]));
  }
  return indices;
}

export function stripAcDoneMarkers(text: string): string {
  if (!text.includes(AC_DONE_FAST_CHECK)) return text;
  AC_DONE_STRIP_RE.lastIndex = 0;
  return text.replace(AC_DONE_STRIP_RE, "");
}
