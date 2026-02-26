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
import { ensureDir, readText, writeText, writeJson, fileExists, removeFile } from "../utils/fs.js";
import { getSessionSlug } from "../sessions/slug.js";
import { getLogger } from "../logging/logger.js";
import { createEngineLogBridge } from "../logging/engine-bridge.js";

export interface ReviewResult {
  findings: ReviewFinding[];
  taskFile: TaskFile | null;
  executed: boolean;
}

export class ReviewOrchestrator {
  private listeners: EngineEventListener[] = [];
  private reviewEngine: Engine | null = null;
  private phase: "idle" | "generating" | "executing" = "idle";
  private stopped = false;

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

  stop(): void {
    this.stopped = true;
    this.reviewEngine?.stop();
  }

  async cleanupPartialFindings(): Promise<void> {
    if (this.phase === "generating") {
      await removeFile(this.sessionPaths.reviewFindings);
    }
  }

  async run(onChunk?: (chunk: string) => void): Promise<ReviewResult> {
    const logger = getLogger();
    // Step 1: Create review/ directory
    await ensureDir(this.sessionPaths.reviewRoot);

    this.emit({ type: "state:change", message: "reviewing" });
    logger.info("review:start", "Review started", {
      sessionRoot: this.sessionPaths.root,
      project: this.config.project.name,
    });

    // Step 2: Run Reviewer to generate findings
    this.phase = "generating";
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

    const sessionSlug = await getSessionSlug(this.sessionPaths);

    let response: string;
    try {
      response = await reviewer.generateFindings(
        prdContent,
        progressContent,
        onChunk,
        sessionSlug,
      );
    } catch (err) {
      if (this.stopped) {
        // Interrupted during findings generation — clean up partial state
        await this.cleanupPartialFindings();
        logger.warn("review:interrupted", "Review interrupted during findings generation");
        throw err;
      }
      logger.error("review:failed", "Review failed during findings generation", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Write findings.md
    await writeText(this.sessionPaths.reviewFindings, response);

    // Write conversation.json (preserved across interruptions for debugging)
    await writeJson(this.sessionPaths.reviewConversation, conversationMessages);

    // Step 3: Extract findings and convert to tasks
    const findings = reviewer.extractFindings(response);
    logger.info("review:findings", "Review findings extracted", {
      count: findings.length,
    });

    // Handle zero findings — skip execution
    if (findings.length === 0) {
      this.phase = "idle";
      this.emit({ type: "complete", message: "Review produced no findings" });
      logger.info("review:complete", "Review completed with no findings");
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
    this.phase = "executing";
    const reviewPaths: SessionPaths = {
      ...this.sessionPaths,
      tasks: this.sessionPaths.reviewTasks,
      progress: this.sessionPaths.reviewProgress,
      logs: `${this.sessionPaths.reviewRoot}/logs`,
    };

    this.reviewEngine = new Engine(
      this.config,
      this.agent,
      this.fallbackAgent,
      reviewPaths,
      this.cwd,
    );
    this.reviewEngine.on(createEngineLogBridge(logger));

    // Forward engine events to our listeners
    this.reviewEngine.on((event) => this.emit(event));

    await this.reviewEngine.run();

    // Step 5: No third pass — return immediately after review tasks complete
    this.phase = "idle";
    logger.info("review:complete", "Review completed with fixes executed", {
      tasks: taskFile.tasks.length,
    });
    return { findings, taskFile, executed: true };
  }
}
