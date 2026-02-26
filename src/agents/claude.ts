import type { AgentExecuteOptions, AgentExecutionHandle, AgentExecutionResult, AgentToolEvent } from "./types.js";
import type { DoctorCheckResult } from "../doctor/types.js";
import { BaseAgentAdapter } from "./base.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileExists } from "../utils/fs.js";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export function buildClaudeCmd(prompt: string, options: Pick<AgentExecuteOptions, "model" | "skipPermissions" | "readOnly">): string[] {
  return [
    "claude",
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.skipPermissions !== false ? ["--dangerously-skip-permissions"] : []),
    ...(options.readOnly ? ["--tools", READ_ONLY_TOOLS.join(",")] : []),
  ];
}

type StreamCallbacks = {
  onText?: (chunk: string) => void;
  onTool?: (event: AgentToolEvent) => void;
};

type ToolUseState = {
  id: string;
  name: string;
  inputValue?: unknown;
  inputText: string;
  emitted: boolean;
};

type ToolResultState = {
  id: string;
  name: string;
  outputValue?: unknown;
  outputText: string;
  emitted: boolean;
};

function extractTextBlocks(content: unknown): string[] {
  if (!content) return [];
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item && typeof item === "object" && "type" in item && (item as { type: string }).type === "text") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts;
  }
  if (typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return [(content as { text: string }).text];
  }
  return [];
}

function extractTextFromRecord(record: Record<string, unknown>): string[] {
  if (typeof record.result === "string") return [record.result];
  const candidates = [
    record.content,
    (record.message as { content?: unknown } | undefined)?.content,
    (record.result as { content?: unknown } | undefined)?.content,
    (record.result as { message?: { content?: unknown } } | undefined)?.message?.content,
  ];
  for (const candidate of candidates) {
    const parts = extractTextBlocks(candidate);
    if (parts.length > 0) return parts;
  }
  return [];
}

function extractToolOutput(block: Record<string, unknown>): unknown {
  if ("output" in block) return block.output;
  if ("content" in block) {
    const content = block.content;
    if (typeof content === "string") return content;
    const parts = extractTextBlocks(content);
    if (parts.length > 0) return parts.join("");
  }
  if ("text" in block) return block.text;
  return undefined;
}

class ClaudeStreamParser {
  private buffer = "";
  private text = "";
  private sawTextDelta = false;
  private currentMessageId: string | null = null;
  private currentMessageSynthetic = false;
  private messageCounter = 0;
  private toolUsesByIndex = new Map<number, ToolUseState>();
  private toolUsesById = new Map<string, ToolUseState>();
  private toolResultsByIndex = new Map<number, ToolResultState>();
  private callbacks: StreamCallbacks;

  constructor(callbacks: StreamCallbacks) {
    this.callbacks = callbacks;
  }

  handleChunk(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) this.handleLine(line);
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  flush(): void {
    const line = this.buffer.trim();
    if (line.length > 0) this.handleLine(line);
    this.buffer = "";
    this.emitPendingTools();
  }

  getText(): string {
    return this.text;
  }

  private handleLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = record.type;
    if (type === "message_start") {
      const message = record.message as Record<string, unknown> | undefined;
      const messageId = typeof message?.id === "string" ? message.id : undefined;
      this.startMessage(messageId);
      return;
    }

    if (!this.currentMessageId && (type === "content_block_start" || type === "content_block_delta")) {
      this.startMessage();
    }
    if (type === "content_block_delta") {
      const delta = record.delta as Record<string, unknown> | undefined;
      const index = typeof record.index === "number" ? record.index : undefined;
      if (typeof delta?.text === "string" && index != null) {
        const toolResult = this.toolResultsByIndex.get(index);
        if (toolResult) {
          toolResult.outputText += delta.text;
          return;
        }
      }
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.appendText(delta.text);
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && index != null) {
        const tool = this.toolUsesByIndex.get(index);
        if (tool) tool.inputText += delta.partial_json;
      }
      return;
    }

    if (type === "content_block_start") {
      const block = record.content_block as Record<string, unknown> | undefined;
      const index = typeof record.index === "number" ? record.index : undefined;
      if (!block || index == null) return;
      const blockType = block.type;
      if (blockType === "text") {
        const parts = extractTextBlocks(block);
        for (const part of parts) this.appendText(part);
        return;
      }
      if (blockType === "tool_use") {
        const id = typeof block.id === "string" ? block.id : `tool-${index}`;
        const name = typeof block.name === "string" ? block.name : "tool";
        const toolState: ToolUseState = {
          id,
          name,
          inputValue: "input" in block ? block.input : undefined,
          inputText: "",
          emitted: false,
        };
        this.toolUsesByIndex.set(index, toolState);
        this.toolUsesById.set(id, toolState);
        if (toolState.inputValue !== undefined) {
          this.emitToolUse(toolState);
        }
        return;
      }
      if (blockType === "tool_result") {
        const id =
          (typeof block.tool_use_id === "string" && block.tool_use_id) ||
          (typeof block.id === "string" && block.id) ||
          `tool-${index}`;
        const name = typeof block.name === "string"
          ? block.name
          : (this.toolUsesById.get(id)?.name ?? "tool");
        const toolState: ToolResultState = {
          id,
          name,
          outputValue: extractToolOutput(block),
          outputText: "",
          emitted: false,
        };
        this.toolResultsByIndex.set(index, toolState);
        if (toolState.outputValue !== undefined) {
          this.emitToolResult(toolState);
        }
        return;
      }
      return;
    }

    if (type === "assistant") {
      const message = record.message as Record<string, unknown> | undefined;
      const messageId = typeof message?.id === "string" ? message.id : undefined;
      if (messageId || this.currentMessageSynthetic) {
        this.startMessage(messageId);
      }
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          const block = item as Record<string, unknown>;
          const blockType = block.type;
          if (blockType === "text") {
            if (this.sawTextDelta) continue;
            const text = (block as { text?: unknown }).text;
            if (typeof text === "string") this.appendText(text);
            continue;
          }
          if (blockType === "thinking") {
            const thinking = (block as { thinking?: unknown }).thinking;
            if (typeof thinking === "string" && thinking.trim()) {
              this.callbacks.onTool?.({ kind: "use", name: "thinking", input: thinking });
            }
            continue;
          }
          if (blockType === "tool_use") {
            const id = typeof block.id === "string" ? block.id : `tool-${this.toolUsesById.size + 1}`;
            const name = typeof block.name === "string" ? block.name : "tool";
            const toolState: ToolUseState = {
              id,
              name,
              inputValue: "input" in block ? block.input : undefined,
              inputText: "",
              emitted: false,
            };
            if (!this.toolUsesById.has(id)) {
              this.toolUsesById.set(id, toolState);
            }
            this.emitToolUse(toolState);
            continue;
          }
          if (blockType === "tool_result") {
            const id =
              (typeof block.tool_use_id === "string" && block.tool_use_id) ||
              (typeof block.id === "string" && block.id) ||
              `tool-${this.toolResultsByIndex.size + 1}`;
            const name = typeof block.name === "string"
              ? block.name
              : (this.toolUsesById.get(id)?.name ?? "tool");
            const toolState: ToolResultState = {
              id,
              name,
              outputValue: extractToolOutput(block),
              outputText: "",
              emitted: false,
            };
            this.emitToolResult(toolState);
            continue;
          }
        }
      }
      return;
    }

    if (type === "content_block_stop") {
      const index = typeof record.index === "number" ? record.index : undefined;
      if (index != null) {
        const toolUse = this.toolUsesByIndex.get(index);
        if (toolUse && !toolUse.emitted) this.emitToolUse(toolUse);
        const toolResult = this.toolResultsByIndex.get(index);
        if (toolResult && !toolResult.emitted) this.emitToolResult(toolResult);
      }
      return;
    }

    if (type === "result" || type === "message_stop") {
      if (!this.sawTextDelta) {
        const parts = extractTextFromRecord(record);
        for (const part of parts) this.appendText(part);
      }
      return;
    }
  }

  private startMessage(messageId?: string): void {
    if (messageId) {
      if (this.currentMessageId === messageId) return;
      if (this.currentMessageSynthetic && this.currentMessageId) {
        this.currentMessageId = messageId;
        this.currentMessageSynthetic = false;
        return;
      }
    } else if (this.currentMessageId) {
      return;
    }

    const resolvedId = messageId ?? `message-${this.messageCounter + 1}`;
    if (resolvedId === this.currentMessageId) return;
    this.emitPendingTools();
    this.currentMessageId = resolvedId;
    this.currentMessageSynthetic = !messageId;
    if (!messageId) this.messageCounter += 1;
    this.sawTextDelta = false;
    this.toolUsesByIndex.clear();
    this.toolResultsByIndex.clear();
  }

  private appendText(text: string): void {
    if (!text) return;
    this.sawTextDelta = true;
    this.text += text;
    this.callbacks.onText?.(text);
  }

  private emitToolUse(tool: ToolUseState): void {
    if (tool.emitted) return;
    tool.emitted = true;
    let input: unknown = tool.inputValue;
    if (input === undefined && tool.inputText.trim()) {
      try {
        input = JSON.parse(tool.inputText);
      } catch {
        input = tool.inputText;
      }
    }
    this.callbacks.onTool?.({ kind: "use", name: tool.name, id: tool.id, input });
  }

  private emitToolResult(tool: ToolResultState): void {
    if (tool.emitted) return;
    tool.emitted = true;
    let output: unknown = tool.outputValue;
    if (output === undefined && tool.outputText.trim()) {
      output = tool.outputText;
    }
    this.callbacks.onTool?.({ kind: "result", name: tool.name, id: tool.id, output });
  }

  private emitPendingTools(): void {
    for (const tool of this.toolUsesByIndex.values()) {
      if (!tool.emitted) this.emitToolUse(tool);
    }
    for (const tool of this.toolResultsByIndex.values()) {
      if (!tool.emitted) this.emitToolResult(tool);
    }
  }
}

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly name = "claude";

  override get installHint() {
    return "install with: npm install -g @anthropic-ai/claude-code";
  }

  protected buildCmd(prompt: string, options: AgentExecuteOptions): string[] {
    return buildClaudeCmd(prompt, options);
  }

  override execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const parser = new ClaudeStreamParser({
      onText: options.onStdout,
      onTool: options.onTool,
    });

    const handle = super.execute(prompt, {
      ...options,
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
    const credPath = join(homedir(), ".claude", "credentials.json");
    if (await fileExists(credPath)) {
      return { name: "claude auth", status: "pass", message: "credentials file found" };
    }
    return { name: "claude auth", status: "warn", message: "could not verify authentication", suggestion: "run: claude login" };
  }
}
