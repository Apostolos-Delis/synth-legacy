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

export function getToolEventDisplay(event: AgentToolEvent): {
  kindLabel: string;
  kindText: string;
  name: string;
  id: string;
  input: string;
  output: string;
} {
  const isUse = event.kind === "use";
  const kindLabel = isUse ? "→" : "←";
  const kindText = isUse ? "tool use" : "tool result";
  const name = event.name || "tool";
  const id = event.id ? ` ${event.id}` : "";
  const input = event.input !== undefined ? truncate(toDisplay(event.input), INPUT_LIMIT) : "";
  const output = event.output !== undefined ? truncate(toDisplay(event.output), OUTPUT_LIMIT) : "";

  return {
    kindLabel,
    kindText,
    name,
    id,
    input,
    output,
  };
}

export function formatToolEvent(event: AgentToolEvent): string {
  const display = getToolEventDisplay(event);
  const lines: string[] = [`[tool:${event.kind}] ${display.name}${display.id}`];

  if (display.input) {
    lines.push(`  input: ${display.input}`);
  }
  if (display.output) {
    lines.push(`  output: ${display.output}`);
  }

  return lines.join("\n");
}
