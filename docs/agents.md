# Agent Adapters

Synth executes tasks by spawning AI coding agents as subprocesses. The agent system is built around an adapter interface that abstracts the differences between Claude Code, OpenAI Codex, and any future agents.

## AgentAdapter Interface

Defined in `src/agents/types.ts`:

```typescript
interface AgentAdapter {
  readonly name: string;
  detect(): Promise<AgentDetectResult>;
  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle;
  dispose(): void;
}
```

### Detection

```typescript
interface AgentDetectResult {
  available: boolean;
  version?: string;
  error?: string;
}
```

`detect()` checks if the agent CLI is installed and returns its version. Called at startup to validate the configured agent.

### Execution

```typescript
interface AgentExecuteOptions {
  cwd: string;
  timeout?: number;
  skipPermissions?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

interface AgentExecutionHandle {
  pid: number;
  promise: Promise<AgentExecutionResult>;
  interrupt(): void;
}

interface AgentExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
```

`execute()` returns a handle immediately — the actual work happens asynchronously via the `promise`. The `interrupt()` function sends SIGTERM to the subprocess. Stdout/stderr are streamed through callbacks for real-time TUI rendering.

### Disposal

`dispose()` cleans up any active subprocess (SIGTERM). Called when the engine shuts down.

## Claude Adapter

`src/agents/claude.ts` — Wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code).

**Detection**: `claude --version`

**Execution command**:

```
claude -p <prompt> --output-format stream-json [--dangerously-skip-permissions]
```

| Flag | Purpose |
|------|---------|
| `-p <prompt>` | Non-interactive single-prompt mode |
| `--output-format stream-json` | Structured output for parsing |
| `--dangerously-skip-permissions` | Skip file/command permission prompts (when `agent.skip_permissions: true`) |

**Stream parsing**: Claude's `stream-json` format emits one JSON object per line. The adapter extracts text content from `assistant` message blocks and the final `result` message, and surfaces tool use/results for TUI logging. Non-JSON lines and system messages are ignored.

## Codex Adapter

`src/agents/codex.ts` — Wraps the [OpenAI Codex CLI](https://github.com/openai/codex).

**Detection**: `codex --version`

**Execution command**:

```
codex --quiet --approval-mode full-auto <prompt>
```

| Flag | Purpose |
|------|---------|
| `--quiet` | Minimal output |
| `--approval-mode full-auto` | No interactive approval prompts |

**Stream handling**: Codex output is plain text — stdout and stderr are passed through directly without JSON parsing.

## Agent Registry

`src/agents/registry.ts` provides a factory function:

```typescript
function getAgent(name: string): AgentAdapter
```

| Name | Adapter |
|------|---------|
| `"claude"` | `ClaudeAdapter` |
| `"codex"` | `CodexAdapter` |

Throws for unknown agent names with a message listing supported agents.

## Fallback Mechanism

When configured in `synth.toml`:

```toml
[agent]
name = "claude"
[agent.fallback]
name = "codex"
```

The engine switches to the fallback agent when rate limiting is detected on the primary agent. This allows uninterrupted execution when one provider is throttling — the loop continues with the fallback while the primary's rate limit cools down.

## Adding a New Agent Adapter

To add support for a new AI coding agent:

1. **Create the adapter** at `src/agents/<name>.ts`:

```typescript
import type { AgentAdapter, AgentDetectResult, AgentExecuteOptions, AgentExecutionHandle } from "./types";
import { spawn } from "../utils/process";

export class MyAgentAdapter implements AgentAdapter {
  readonly name = "my-agent";

  async detect(): Promise<AgentDetectResult> {
    // Check if CLI is installed
    const handle = spawn({ cmd: ["my-agent", "--version"] });
    const result = await handle.promise;
    return result.exitCode === 0
      ? { available: true, version: result.stdout.trim() }
      : { available: false, error: result.stderr };
  }

  execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
    const cmd = ["my-agent", "run", prompt];
    // Add flags based on options...

    const handle = spawn({
      cmd,
      cwd: options.cwd,
      timeout: options.timeout,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    return {
      pid: handle.pid,
      promise: handle.promise,
      interrupt: () => handle.interrupt(),
    };
  }

  dispose(): void {
    // Clean up active subprocess if any
  }
}
```

2. **Register it** in `src/agents/registry.ts`:

```typescript
import { MyAgentAdapter } from "./my-agent";

export function getAgent(name: string): AgentAdapter {
  switch (name) {
    case "claude": return new ClaudeAdapter();
    case "codex":  return new CodexAdapter();
    case "my-agent": return new MyAgentAdapter();
    default: throw new Error(`Unknown agent: ${name}. Supported: claude, codex, my-agent`);
  }
}
```

3. **Update the config type** in `src/config/types.ts` to allow the new name:

```typescript
agent: {
  name: "claude" | "codex" | "my-agent";
  // ...
}
```

The key contract: `execute()` must return immediately with a handle, stream output through the callbacks, and resolve the promise when the subprocess exits. The engine handles everything else — retries, timeouts, output logging, and state management.
