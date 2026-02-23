export const AC_DONE_PATTERN = /<ac-done>(\d+)<\/ac-done>/g;

export function parseAcDoneMarkers(text: string): number[] {
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(AC_DONE_PATTERN.source, AC_DONE_PATTERN.flags);
  while ((match = re.exec(text)) !== null) {
    indices.push(Number(match[1]));
  }
  return indices;
}

export function stripAcDoneMarkers(text: string): string {
  return text.replace(/<ac-done>[^<]*<\/ac-done>/g, "");
}
