const ANSI_REGEX = new RegExp(
  '\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07]*\\x07|\\x1b[()][AB012]',
  'g'
);

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length === 0) return [""];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) { lines.push(""); continue; }
    let remaining = paragraph;
    while (remaining.length > 0) {
      if (remaining.length <= width) { lines.push(remaining); break; }
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
  }
  return lines.length > 0 ? lines : [""];
}
