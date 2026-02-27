import type { AgentExecuteOptions, AgentExecutionHandle, AgentExecutionResult, AgentToolEvent } from "./types.js";
import type { DoctorCheckResult } from "../doctor/types.js";
import { BaseAgentAdapter } from "./base.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileExists, readText } from "../utils/fs.js";

export function buildCodexCmd(_prompt: string, options: Pick<AgentExecuteOptions, "readOnly" | "model">): string[] {
  const args: string[] = ["codex"];
  if (options.readOnly) {
    args.push("-a", "on-request");
  }
  args.push("exec");
  if (!options.readOnly) {
    args.push("--full-auto");
  }
  args.push("--json");
  if (options.model) {
    args.push("--model", options.model);
  }
  return [
    ...args,
    "--sandbox",
    options.readOnly ? "read-only" : "workspace-write",
    "-",
  ];
}

type CodexCallbacks = {
  onText?: (chunk: string) => void;
  onTool?: (event: AgentToolEvent) => void;
};

class CodexStreamParser {
  private buffer = "";
  private text = "";
  private callbacks: CodexCallbacks;

  constructor(callbacks: CodexCallbacks) {
    this.callbacks = callbacks;
  }

  handleChunk(chunk: string): void {
    this.buffer += chunk;
    let start = 0;
    let newlineIdx = this.buffer.indexOf("\n", start);
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(start, newlineIdx);
      start = newlineIdx + 1;
      this.handleLine(line);
      newlineIdx = this.buffer.indexOf("\n", start);
    }
    if (start > 0) {
      this.buffer = start < this.buffer.length ? this.buffer.slice(start) : "";
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer);
      this.buffer = "";
    }
  }

  getText(): string {
    return this.text;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.appendText(line);
      return;
    }

    const type = record.type;
    if (type === "item.started" || type === "item.completed") {
      const item = record.item as Record<string, unknown> | undefined;
      if (!item) return;
      const itemType = item.type;

      if (itemType === "agent_message") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") this.appendAgentMessage(text);
        return;
      }

      if (itemType === "command_execution") {
        if (type === "item.started") {
          const command = (item as { command?: unknown }).command;
          if (typeof command === "string") {
            this.emitTool({ kind: "use", name: "shell", input: { command } });
          }
          return;
        }
        if (type === "item.completed") {
          const output = (item as { aggregated_output?: unknown; output?: unknown }).aggregated_output
            ?? (item as { output?: unknown }).output;
          const exitCode = (item as { exit_code?: unknown }).exit_code;
          let result: unknown = output;
          if (exitCode !== undefined) {
            result = { exitCode, output };
          }
          this.emitTool({ kind: "result", name: "shell", output: result });
          return;
        }
      }

      if (itemType === "file_edit" || itemType === "file_write" || itemType === "file_read") {
        const name = String(itemType);
        if (type === "item.started") {
          const path = (item as { file_path?: unknown; path?: unknown }).file_path
            ?? (item as { path?: unknown }).path
            ?? "unknown";
          this.emitTool({ kind: "use", name, input: { path } });
          return;
        }
        if (type === "item.completed") {
          this.emitTool({ kind: "result", name });
          return;
        }
      }
    }

    if (type === "error" || record.error) {
      const errorObj = record.error as { message?: unknown } | undefined;
      const message = errorObj?.message ?? record.message ?? "Unknown error";
      this.appendText(typeof message === "string" ? `Error: ${message}` : "Error: Unknown error");
      return;
    }
  }

  private appendText(text: string): void {
    if (!text) return;
    this.text += text;
    this.callbacks.onText?.(text);
  }

  private appendAgentMessage(text: string): void {
    if (!text) return;
    if (this.text.length > 0) {
      const last = this.text[this.text.length - 1];
      const first = text[0];
      if (last && first && !/\s/.test(last) && !/\s/.test(first)) {
        this.appendText(" ");
      }
    }
    this.appendText(text);
  }

  private emitTool(event: AgentToolEvent): void {
    this.callbacks.onTool?.(event);
  }
}

export class CodexAdapter extends BaseAgentAdapter {
  readonly name = "codex";

  override get installHint() {
    return "install with: npm install -g @openai/codex";
  }

  protected buildCmd(prompt: string, options: AgentExecuteOptions): string[] {
    return buildCodexCmd(prompt, options);
  }

  override execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const parser = new CodexStreamParser({
      onText: options.onStdout,
      onTool: options.onTool,
    });

    const handle = super.execute(prompt, {
      ...options,
      stdin: prompt,
      onStdout: (chunk) => parser.handleChunk(chunk),
    });

    const promise: Promise<AgentExecutionResult> = handle.promise.then((result) => {
      parser.flush();
      return { ...result, rawStdout: result.rawStdout ?? result.stdout, stdout: parser.getText() };
    });

    return {
      pid: handle.pid,
      promise,
      interrupt: handle.interrupt,
    };
  }

  override async checkAuth(): Promise<DoctorCheckResult | null> {
    if (process.env.OPENAI_API_KEY) {
      return { name: "codex auth", status: "pass", message: "OPENAI_API_KEY set" };
    }
    try {
      const authPath = join(homedir(), ".codex", "auth.json");
      if (await fileExists(authPath)) {
        const data = JSON.parse(await readText(authPath));
        if (data.OPENAI_API_KEY) {
          return { name: "codex auth", status: "pass", message: "authenticated via codex login" };
        }
      }
    } catch {
      // fall through to fail
    }
    return { name: "codex auth", status: "fail", message: "OPENAI_API_KEY not set", suggestion: "set OPENAI_API_KEY or run: codex login" };
  }
}
