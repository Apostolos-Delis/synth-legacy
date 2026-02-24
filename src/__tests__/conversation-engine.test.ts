import { describe, test, expect, mock } from "bun:test";
import { ConversationEngine } from "../conversation/engine.js";
import type { AgentAdapter, AgentExecuteOptions, AgentExecutionHandle } from "../agents/types.js";
import type { ConversationMessage } from "../conversation/types.js";

function makeAgent(response = "ok"): AgentAdapter {
  return {
    name: "test-agent",
    detect: async () => ({ available: true }),
    execute(_prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
      options.onStdout?.(response);
      return {
        pid: 1,
        promise: Promise.resolve({ exitCode: 0, stdout: response, stderr: "", timedOut: false }),
        interrupt() {},
      };
    },
    dispose() {},
  };
}

function makeEngine(overrides: {
  agent?: AgentAdapter;
  persist?: (messages: ConversationMessage[]) => void | Promise<void>;
  promptSuffix?: string;
} = {}) {
  return new ConversationEngine({
    agent: overrides.agent ?? makeAgent(),
    cwd: "/tmp",
    systemPrompt: "You are a test assistant.",
    persist: overrides.persist,
    promptSuffix: overrides.promptSuffix,
  });
}

describe("ConversationEngine", () => {
  describe("persist callback", () => {
    test("calls persist after each send with full history", async () => {
      const persisted: ConversationMessage[][] = [];
      const persist = mock((msgs: ConversationMessage[]) => {
        persisted.push(msgs);
      });

      const engine = makeEngine({ persist });
      await engine.send("hello");

      expect(persist).toHaveBeenCalledTimes(1);
      expect(persisted[0]).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
      ]);
    });

    test("persist receives growing history across multiple sends", async () => {
      const persisted: ConversationMessage[][] = [];
      const persist = (msgs: ConversationMessage[]) => {
        persisted.push(msgs);
      };

      const engine = makeEngine({ persist });
      await engine.send("first");
      await engine.send("second");

      expect(persisted).toHaveLength(2);
      expect(persisted[1]).toHaveLength(4);
      expect(persisted[1][2]).toEqual({ role: "user", content: "second" });
    });

    test("persist errors propagate to caller", async () => {
      const persist = () => {
        throw new Error("disk full");
      };

      const engine = makeEngine({ persist });
      expect(engine.send("hello")).rejects.toThrow("disk full");
    });

    test("async persist errors propagate to caller", async () => {
      const persist = async () => {
        throw new Error("network down");
      };

      const engine = makeEngine({ persist });
      expect(engine.send("hello")).rejects.toThrow("network down");
    });
  });

  describe("restore + send interaction", () => {
    test("restored history is included in next prompt", async () => {
      let capturedPrompt = "";
      const agent: AgentAdapter = {
        name: "test-agent",
        detect: async () => ({ available: true }),
        execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
          capturedPrompt = prompt;
          options.onStdout?.("response");
          return {
            pid: 1,
            promise: Promise.resolve({ exitCode: 0, stdout: "response", stderr: "", timedOut: false }),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const engine = makeEngine({ agent });
      engine.restoreHistory([
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ]);

      await engine.send("follow-up");

      expect(capturedPrompt).toContain("User: previous question");
      expect(capturedPrompt).toContain("Assistant: previous answer");
      expect(capturedPrompt).toContain("User: follow-up");
    });

    test("restored history is fully included in prompt", async () => {
      let capturedPrompt = "";
      const agent: AgentAdapter = {
        name: "test-agent",
        detect: async () => ({ available: true }),
        execute(prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
          capturedPrompt = prompt;
          options.onStdout?.("r");
          return {
            pid: 1,
            promise: Promise.resolve({ exitCode: 0, stdout: "r", stderr: "", timedOut: false }),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const engine = makeEngine({ agent });
      engine.restoreHistory([
        { role: "user", content: "old1" },
        { role: "assistant", content: "old2" },
        { role: "user", content: "old3" },
        { role: "assistant", content: "old4" },
      ]);

      await engine.send("new");

      expect(capturedPrompt).toContain("Conversation so far:");
      expect(capturedPrompt).toContain("User: old1");
      expect(capturedPrompt).toContain("Assistant: old2");
      expect(capturedPrompt).toContain("User: old3");
      expect(capturedPrompt).toContain("Assistant: old4");
      expect(capturedPrompt).toContain("User: new");
    });

    test("getHistory returns restored messages plus new ones", async () => {
      const engine = makeEngine();
      engine.restoreHistory([
        { role: "user", content: "restored" },
        { role: "assistant", content: "answer" },
      ]);

      await engine.send("new question");

      const history = engine.getHistory();
      expect(history).toHaveLength(4);
      expect(history[0].content).toBe("restored");
      expect(history[2].content).toBe("new question");
      expect(history[3].content).toBe("ok");
    });

    test("restoreHistory replaces existing history", async () => {
      const engine = makeEngine();
      await engine.send("first");

      engine.restoreHistory([{ role: "user", content: "replaced" }]);

      const history = engine.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("replaced");
    });
  });

  describe("agent failure handling", () => {
    test("agent rejection propagates to send caller", async () => {
      const agent: AgentAdapter = {
        name: "failing-agent",
        detect: async () => ({ available: true }),
        execute(_prompt: string, _options: AgentExecuteOptions): AgentExecutionHandle {
          return {
            pid: 1,
            promise: Promise.reject(new Error("agent crashed")),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const engine = makeEngine({ agent });
      expect(engine.send("hello")).rejects.toThrow("agent crashed");
    });

    test("persist is not called when agent fails", async () => {
      const persist = mock(() => {});
      const agent: AgentAdapter = {
        name: "failing-agent",
        detect: async () => ({ available: true }),
        execute(_prompt: string, _options: AgentExecuteOptions): AgentExecutionHandle {
          return {
            pid: 1,
            promise: Promise.reject(new Error("agent crashed")),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const engine = makeEngine({ agent, persist });

      try {
        await engine.send("hello");
      } catch {
        // expected
      }

      expect(persist).toHaveBeenCalledTimes(0);
    });

    test("agent returning empty output is stored as-is", async () => {
      const agent: AgentAdapter = {
        name: "silent-agent",
        detect: async () => ({ available: true }),
        execute(_prompt: string, _options: AgentExecuteOptions): AgentExecutionHandle {
          // onStdout never called — empty output
          return {
            pid: 1,
            promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const engine = makeEngine({ agent });
      const result = await engine.send("hello");

      expect(result).toBe("");
      expect(engine.getHistory()).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
      ]);
    });

    test("onChunk receives streamed output", async () => {
      const agent: AgentAdapter = {
        name: "chunked-agent",
        detect: async () => ({ available: true }),
        execute(_prompt: string, options: AgentExecuteOptions): AgentExecutionHandle {
          options.onStdout?.("chunk1");
          options.onStdout?.("chunk2");
          return {
            pid: 1,
            promise: Promise.resolve({ exitCode: 0, stdout: "chunk1chunk2", stderr: "", timedOut: false }),
            interrupt() {},
          };
        },
        dispose() {},
      };

      const chunks: string[] = [];
      const engine = makeEngine({ agent });
      await engine.send("hello", (chunk) => chunks.push(chunk));

      expect(chunks).toEqual(["chunk1", "chunk2"]);
    });
  });
});
