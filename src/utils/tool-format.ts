import type { AgentToolEvent } from "../agents/types.js";

const INPUT_LIMIT = 600;
const OUTPUT_LIMIT = 1200;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function toDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatToolEvent(event: AgentToolEvent): string {
  const id = event.id ? ` ${event.id}` : "";
  const lines: string[] = [`[tool:${event.kind}] ${event.name}${id}`];

  if (event.input !== undefined) {
    const input = truncate(toDisplay(event.input), INPUT_LIMIT);
    lines.push(`  input: ${input}`);
  }
  if (event.output !== undefined) {
    const output = truncate(toDisplay(event.output), OUTPUT_LIMIT);
    lines.push(`  output: ${output}`);
  }

  return lines.join("\n");
}
