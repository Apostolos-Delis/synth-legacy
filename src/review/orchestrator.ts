import type { AgentAdapter } from "../agents/types.js";
import type { SynthConfig } from "../config/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { TaskFile } from "../tasks/types.js";
import type { EngineEvent, EngineEventListener } from "../engine/types.js";
import type { ReviewFinding } from "./types.js";
import type { ConversationMessage } from "../conversation/types.js";
import { Reviewer } from "./reviewer.js";
import { Engine } from "../engine/engine.js";
import { saveTasks } from "../tasks/store.js";
import { ensureDir, readText, writeText, writeJson, fileExists } from "../utils/fs.js";

export interface ReviewResult {
  findings: ReviewFinding[];
  taskFile: TaskFile | null;
  executed: boolean;
}

export class ReviewOrchestrator {
  private listeners: EngineEventListener[] = [];

  constructor(
    private config: SynthConfig,
    private agent: AgentAdapter,
    private fallbackAgent: AgentAdapter | null,
    private sessionPaths: SessionPaths,
    private cwd: string,
  ) {}

  on(listener: EngineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async run(onChunk?: (chunk: string) => void): Promise<ReviewResult> {
    // Step 1: Create review/ directory
    await ensureDir(this.sessionPaths.reviewRoot);

    this.emit({ type: "state:change", message: "reviewing" });

    // Step 2: Run Reviewer to generate findings
    const conversationMessages: ConversationMessage[] = [];
    const reviewer = new Reviewer(
      this.agent,
      this.cwd,
      this.config.agent.model,
      (messages) => {
        conversationMessages.length = 0;
        conversationMessages.push(...messages);
      },
    );

    const prdContent = (await fileExists(this.sessionPaths.prd))
      ? await readText(this.sessionPaths.prd)
      : "";

    const progressContent = (await fileExists(this.sessionPaths.progress))
      ? await readText(this.sessionPaths.progress)
      : "";

    const response = await reviewer.generateFindings(
      prdContent,
      progressContent,
      onChunk,
    );

    // Write findings.md
    await writeText(this.sessionPaths.reviewFindings, response);

    // Write conversation.json
    await writeJson(this.sessionPaths.reviewConversation, conversationMessages);

    // Step 3: Extract findings and convert to tasks
    const findings = reviewer.extractFindings(response);

    // Handle zero findings — skip execution
    if (findings.length === 0) {
      this.emit({ type: "complete", message: "Review produced no findings" });
      return { findings, taskFile: null, executed: false };
    }

    const taskFile = reviewer.convertToTasks(
      findings,
      this.config.project.name,
      this.config.project.branch,
    );

    // Write review/tasks.json
    await saveTasks(this.sessionPaths.reviewTasks, taskFile);

    // Step 4: Execute review tasks via Engine with review-specific paths
    const reviewPaths: SessionPaths = {
      ...this.sessionPaths,
      tasks: this.sessionPaths.reviewTasks,
      progress: this.sessionPaths.reviewProgress,
      logs: `${this.sessionPaths.reviewRoot}/logs`,
    };

    const engine = new Engine(
      this.config,
      this.agent,
      this.fallbackAgent,
      reviewPaths,
      this.cwd,
    );

    // Forward engine events to our listeners
    engine.on((event) => this.emit(event));

    await engine.run();

    // Step 5: No third pass — return immediately after review tasks complete
    return { findings, taskFile, executed: true };
  }
}
