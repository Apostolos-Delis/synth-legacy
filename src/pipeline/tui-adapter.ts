import { createElement } from "react";
import type { TuiEngineData, TuiContext, CompletionSummary } from "../tui/types.js";
import type { EngineEvent, IterationResult } from "../engine/types.js";
import type { ParallelEvent } from "../parallel/events.js";
import type { Task } from "../tasks/types.js";
import type { SessionPaths } from "../sessions/types.js";
import type { SynthConfig } from "../config/types.js";
import type { TaskGraphAnalysis } from "../parallel/task-graph.js";
import type { WorkerDisplayState } from "../parallel/worker.js";
import type { PipelineEmitter, PipelineEvent, UserAction } from "./types.js";
import type { ParallelTuiState } from "../finalize/parallel-bridge.js";
import {
  applyTaskStatus,
  resetTaskOutput,
  setTaskStartTime,
  setTaskElapsedMs,
  addTaskElapsedMs,
  appendTaskOutput,
} from "../tui/task-state.js";
import { stripAnsi } from "../tui/utils.js";
import { formatToolEvent } from "../utils/tool-format.js";
import { getLogger } from "../logging/logger.js";
import { TokenAccumulator } from "../engine/tokens.js";
import { globalTrace } from "../utils/perf.js";
import { loadTaskOutput, buildIterationMap } from "../engine/output-index.js";
import { startTuiProfiler, stopTuiProfiler, countEvent, startSpan, endSpan, recordSpan } from "../tui/profiler.js";

const MAX_OUTPUT_LENGTH = 40_000;

// ---------------------------------------------------------------------------
// TuiAdapterOptions
// ---------------------------------------------------------------------------

export interface TuiAdapterOptions {
  tasks: Task[];
  config: SynthConfig;
  sessionId: string;
  sessionPaths: SessionPaths;
  startIteration: number;
  parallelMode: boolean;
  taskGraphAnalysis?: TaskGraphAnalysis;
  getWorkerDisplayStates?: () => WorkerDisplayState[];
}

// ---------------------------------------------------------------------------
// TuiAdapter
// ---------------------------------------------------------------------------

export class TuiAdapter {
  private pipeline: PipelineEmitter;
  private tuiContext: TuiContext | undefined;
  private options: TuiAdapterOptions;

  private ownsRenderer: boolean;
  private renderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>> | null = null;
  private root: ReturnType<typeof import("@opentui/react")["createRoot"]> | null = null;
  private tuiData: TuiEngineData | null = null;
  private parallelState: ParallelTuiState | null = null;

  private ParallelBridgeComponent: typeof import("../tui/ParallelBridge.js")["ParallelBridge"] | null = null;
  private SerialBridgeComponent: typeof import("../tui/ParallelBridge.js")["SerialBridge"] | null = null;
  private applyParallelEventFn: typeof import("../finalize/parallel-bridge.js")["applyParallelEvent"] | null = null;
  private originalRequestRender: (() => void) | null = null;

  private unsubscribe: (() => void) | null = null;
  private destroyed = false;

  // Serial rendering state
  private firstTokenRendered = false;
  private streamRenderScheduled = false;
  private serialBridgeRendered = false;
  private taskStartTimes = new Map<string, number>();
  private tokenAccumulator = new TokenAccumulator();

  // Parallel rendering state
  private parallelRenderScheduled = false;
  private parallelDestroyed = false;
  private workerElapsedByTaskId = new Map<string, number>();
  private failureReasons = new Map<string, string>();

  // Completion action state
  private allowFinalize = false;
  private allowReview = false;

  constructor(
    pipeline: PipelineEmitter,
    options: TuiAdapterOptions,
    tuiContext?: TuiContext,
  ) {
    this.pipeline = pipeline;
    this.options = options;
    this.tuiContext = tuiContext;
    this.ownsRenderer = !tuiContext;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const { config, tasks, sessionId, startIteration, parallelMode } = this.options;
    startTuiProfiler(this.options.sessionPaths);

    const [{ createCliRenderer }, { createRoot }, { ParallelBridge, SerialBridge }] = await Promise.all([
      import("@opentui/core"),
      import("@opentui/react"),
      import("../tui/ParallelBridge.js"),
    ]);

    this.ParallelBridgeComponent = ParallelBridge;
    this.SerialBridgeComponent = SerialBridge;

    if (this.tuiContext) {
      this.renderer = this.tuiContext.renderer;
      this.root = this.tuiContext.root;
    } else {
      this.renderer = await createCliRenderer({
        exitOnCtrlC: false,
        useMouse: false,
        enableMouseMovement: false,
      });
      this.root = createRoot(this.renderer);
    }

    // No renderer instrumentation — wrapping loop() with async/await
    // changes frame scheduling timing and adds per-frame overhead.

    const initialTaskElapsedMs = Object.fromEntries(
      tasks
        .filter((t) => t.durationMs != null)
        .map((t) => [t.id, t.durationMs as number]),
    );

    if (parallelMode) {
      this.tuiData = {
        engineState: "executing",
        iteration: 0,
        maxIterations: 1,
        tasks: [...tasks],
        currentTaskId: null,
        output: "",
        agentName: config.agent.name,
        projectName: config.project.name,
        sessionId,
        startTime: Date.now(),
        interviewMessages: [],
        isThinking: false,
        currentPhase: "Parallel execution",
        phaseStartTime: Date.now(),
        completionSummary: null,
        taskOutputMap: {},
        taskElapsedMs: initialTaskElapsedMs,
        taskStartTimes: {},
        iterationEntries: [],
        configDisplay: JSON.stringify(config, null, 2),
        tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
      };

      const { createInitialTuiState, applyParallelEvent } = await import("../finalize/parallel-bridge.js");
      this.applyParallelEventFn = applyParallelEvent;

      const totalTasks = tasks.length;
      const initialMergedTasks = tasks.filter(
        (t) => t.status === "done" || t.status === "skipped",
      ).length;
      this.parallelState = createInitialTuiState(totalTasks, initialMergedTasks);

      // Compute task graph analysis if not provided
      if (!this.options.taskGraphAnalysis) {
        const { analyzeTaskGraph } = await import("../parallel/task-graph.js");
        const actionableTasks = tasks.filter(
          (t) => t.status === "open" || t.status === "in_progress",
        );
        this.options.taskGraphAnalysis = analyzeTaskGraph(actionableTasks);
      }

      this.renderParallel();
    } else {
      this.tuiData = {
        engineState: "executing",
        iteration: startIteration,
        maxIterations: config.execution.max_iterations,
        tasks: [...tasks],
        currentTaskId: null,
        output: "",
        agentName: config.agent.name,
        projectName: config.project.name,
        sessionId,
        startTime: Date.now(),
        interviewMessages: [],
        isThinking: false,
        currentPhase: null,
        phaseStartTime: null,
        completionSummary: null,
        taskOutputMap: {},
        taskElapsedMs: initialTaskElapsedMs,
        taskStartTimes: {},
        iterationEntries: [],
        configDisplay: JSON.stringify(config, null, 2),
        tokenUsage: { sessionTotal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, taskTotals: {}, hasData: false },
      };

      this.tuiData._onQuit = () => {
        this.cleanup();
        process.exit(0);
      };
      this.tuiData._onFinalize = undefined;
      this.tuiData._onReviewStart = undefined;

      this.loadHistoricalIterationData();
    }

    this.unsubscribe = this.pipeline.on((event) => this.handlePipelineEvent(event));

    if (!parallelMode) {
      this.renderSerial();
    }
  }

  getTuiData(): TuiEngineData | null {
    return this.tuiData;
  }

  getTuiContext(): TuiContext | null {
    if (this.renderer && this.root) {
      return { renderer: this.renderer, root: this.root };
    }
    return null;
  }

  cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.parallelDestroyed = true;
    this.unsubscribe?.();
    if (this.renderer && this.originalRequestRender) {
      (this.renderer as { requestRender: () => void }).requestRender = this.originalRequestRender;
      this.originalRequestRender = null;
    }
    stopTuiProfiler();
    if (this.ownsRenderer) {
      if (this.root) this.root.unmount();
      if (this.renderer) this.renderer.destroy();
    }
    this.renderer = null;
    this.root = null;
  }

  // ---------------------------------------------------------------------------
  // Private — event dispatch
  // ---------------------------------------------------------------------------

  private handlePipelineEvent(event: PipelineEvent): void {
    if (this.destroyed) return;

    switch (event.type) {
      case "engine:event":
        this.handleEngineEvent(event.event);
        break;
      case "parallel:event":
        this.handleParallelEvent(event.event);
        break;
      case "summary:ready":
        this.handleSummaryReady(event.summary);
        break;
      case "review:status-changed":
        this.handleReviewStatusChanged(event.status, event.error);
        break;
      case "execution:completed":
        this.handleExecutionCompleted(event.success);
        break;
      case "phase:changed":
        this.handlePhaseChanged(event.phase);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — serial engine event → TUI mutations
  // ---------------------------------------------------------------------------

  private handleEngineEvent(event: EngineEvent): void {
    if (!this.tuiData) return;
    const showToolLogs = this.options.config.tui?.show_tool_logs !== false;

    switch (event.type) {
      case "iteration:start":
        countEvent("engine:iteration:start");
        this.tuiData.iteration = event.iteration ?? this.tuiData.iteration;
        this.tuiData.currentTaskId = event.taskId ?? null;
        this.tuiData.output = "";
        this.firstTokenRendered = false;
        break;

      case "task:start":
        this.tuiData.isThinking = true;
        this.tuiData.currentPhase = "Starting task...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        if (event.taskId) {
          resetTaskOutput(this.tuiData, event.taskId);
          const now = Date.now();
          this.taskStartTimes.set(event.taskId, now);
          setTaskStartTime(this.tuiData, event.taskId, now);
          applyTaskStatus(this.tuiData, event.taskId, "in_progress");
        }
        break;

      case "task:complete":
      case "task:failed": {
        this.tuiData.isThinking = false;
        this.tuiData.currentPhase = null;
        this.tuiData.phaseStartTime = null;
        if (event.taskId) {
          applyTaskStatus(this.tuiData, event.taskId, event.type === "task:complete" ? "done" : "failed");
        }
        if (event.taskId) {
          const startTime = this.taskStartTimes.get(event.taskId);
          if (startTime) {
            const taskElapsed = Date.now() - startTime;
            const elapsedSecs = Math.floor(taskElapsed / 1000);
            addTaskElapsedMs(this.tuiData, event.taskId, taskElapsed);
            const label = event.type === "task:complete" ? "Completed" : "Failed";
            const suffix = `\n${label} in ${elapsedSecs}s`;
            appendTaskOutput(this.tuiData, event.taskId, suffix, MAX_OUTPUT_LENGTH);
            if (this.tuiData.currentTaskId === event.taskId) {
              this.tuiData.output += suffix;
            }
            this.taskStartTimes.delete(event.taskId);
          }
        }
        break;
      }

      case "phase:scanning":
        this.tuiData.currentPhase = "Scanning project files...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        break;

      case "phase:building-prompt":
        this.tuiData.currentPhase = "Building prompt...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        break;

      case "phase:spawning-agent":
        this.tuiData.currentPhase = "Spawning agent...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        break;

      case "phase:waiting-response":
        this.tuiData.currentPhase = "Waiting for response...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        break;

      case "phase:streaming":
        this.tuiData.currentPhase = "Streaming response...";
        this.tuiData.phaseStartTime = event.timestamp ?? Date.now();
        break;

      case "agent:stdout": {
        countEvent("engine:agent:stdout");
        const renderStart = event.isFirstChunk ? performance.now() : 0;
        if (event.isFirstChunk) {
          this.tuiData.currentPhase = "Streaming response...";
          this.tuiData.phaseStartTime = Date.now();
        }
        const stripped = event.message ? stripAnsi(event.message) : "";
        if (stripped) {
          this.tuiData.output += stripped;
          // Only trim when 10% over limit to amortize the cost of the 100KB slice
          if (this.tuiData.output.length > MAX_OUTPUT_LENGTH * 1.1) {
            this.tuiData.output = this.tuiData.output.slice(-MAX_OUTPUT_LENGTH);
          }
          if (this.tuiData.currentTaskId && this.tuiData.currentTaskId in this.tuiData.taskOutputMap) {
            appendTaskOutput(this.tuiData, this.tuiData.currentTaskId, stripped, MAX_OUTPUT_LENGTH);
          }
        }
        // Minimal throttle for stdout only — can fire hundreds of times/sec.
        // First chunk renders immediately, then cap at ~60fps.
        if (event.isFirstChunk || !this.streamRenderScheduled) {
          this.streamRenderScheduled = true;
          if (event.isFirstChunk) {
            this.renderSerial();
          } else {
            setTimeout(() => {
              this.streamRenderScheduled = false;
              this.renderSerial();
            }, 16);
          }
        }
        if (event.isFirstChunk && !this.firstTokenRendered) {
          this.firstTokenRendered = true;
          const renderMs = performance.now() - renderStart;
          globalTrace().recordPhase("tui:first-token-render", renderMs);
        }
        return;
      }

      case "agent:stderr":
        countEvent("engine:agent:stderr");
        if (event.message) {
          this.tuiData.output += stripAnsi(event.message);
          if (this.tuiData.output.length > MAX_OUTPUT_LENGTH * 1.1) {
            this.tuiData.output = this.tuiData.output.slice(-MAX_OUTPUT_LENGTH);
          }
        }
        break;

      case "agent:tool": {
        countEvent("engine:agent:tool");
        if (!showToolLogs) break;
        if (!event.tool) break;
        const formatted = formatToolEvent(event.tool);
        const suffix = `\n${formatted}\n`;
        this.tuiData.output += suffix;
        if (this.tuiData.output.length > MAX_OUTPUT_LENGTH * 1.1) {
          this.tuiData.output = this.tuiData.output.slice(-MAX_OUTPUT_LENGTH);
        }
        if (this.tuiData.currentTaskId && this.tuiData.currentTaskId in this.tuiData.taskOutputMap) {
          appendTaskOutput(this.tuiData, this.tuiData.currentTaskId, suffix, MAX_OUTPUT_LENGTH);
        }
        this.renderSerial();
        return;
      }

      case "iteration:end": {
        const iterData = event.data as IterationResult | undefined;
        if (event.taskId && event.iteration != null) {
          this.tuiData.iterationEntries.push({
            iteration: event.iteration,
            taskId: event.taskId,
            status: iterData?.success ? "done" : "failed",
            timestamp: Date.now(),
          });
        }
        if (iterData?.tokenUsage && event.taskId) {
          this.tokenAccumulator.add(event.taskId, {
            inputTokens: iterData.tokenUsage.inputTokens,
            outputTokens: iterData.tokenUsage.outputTokens,
            totalTokens: iterData.tokenUsage.inputTokens + iterData.tokenUsage.outputTokens,
          });
          this.tuiData.tokenUsage = {
            sessionTotal: this.tokenAccumulator.getSessionTotal(),
            taskTotals: Object.fromEntries(
              this.tuiData.tasks.map((t) => [t.id, this.tokenAccumulator.getTaskTotal(t.id) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]).filter(([, v]) => (v as { totalTokens: number }).totalTokens > 0),
            ),
            hasData: this.tokenAccumulator.hasData(),
          };
        }
        break;
      }

      case "complete":
        this.tuiData.engineState = "completed";
        break;

      case "state:change":
        if (event.message) this.tuiData.engineState = event.message as TuiEngineData["engineState"];
        break;
    }

    this.renderSerial();
  }

  // ---------------------------------------------------------------------------
  // Private — parallel event → TUI mutations
  // ---------------------------------------------------------------------------

  private handleParallelEvent(event: ParallelEvent): void {
    if (!this.tuiData || !this.parallelState || !this.applyParallelEventFn) return;
    const getStates = this.options.getWorkerDisplayStates;

    this.applyParallelEventFn(event, this.parallelState, getStates);

    if (event.type === "worker:started" || event.type === "worker:progress" || event.type === "worker:completed" || event.type === "worker:failed") {
      if (getStates) {
        const workers = getStates();
        const worker = workers.find((w) => w.id === event.workerId);
        if (worker) {
          const taskId = worker.task.id;
          if (event.type === "worker:started") {
            const task = this.tuiData.tasks.find((t) => t.id === taskId);
            if (task && task.status !== "done" && task.status !== "failed" && task.status !== "in_progress") {
              applyTaskStatus(this.tuiData, taskId, "in_progress");
            }
          }
          const startTime = Date.now() - worker.elapsedMs;
          setTaskStartTime(this.tuiData, taskId, startTime);
          setTaskElapsedMs(this.tuiData, taskId, worker.elapsedMs);
          this.workerElapsedByTaskId.set(taskId, worker.elapsedMs);
        }
      }
    }

    if (event.type === "worker:output" && "taskId" in event) {
      countEvent("parallel:worker:output");
      const taskId = (event as { taskId: string }).taskId;
      appendTaskOutput(this.tuiData, taskId, (event as { message: string }).message, MAX_OUTPUT_LENGTH);
    }

    if (event.type === "merge:completed") {
      applyTaskStatus(this.tuiData, event.taskId, "done");
      const elapsed = this.workerElapsedByTaskId.get(event.taskId);
      if (elapsed != null) {
        setTaskElapsedMs(this.tuiData, event.taskId, elapsed);
      }
    }

    if (event.type === "merge:failed" || event.type === "merge:skipped") {
      applyTaskStatus(this.tuiData, event.taskId, "failed");
      if (event.type === "merge:failed") {
        this.failureReasons.set(event.taskId, event.reason ?? "Merge failed");
      } else {
        this.failureReasons.set(event.taskId, event.reason);
      }
    }

    if (event.type === "task:requeued") {
      applyTaskStatus(this.tuiData, event.taskId, "open");
    }

    if (!this.parallelDestroyed) {
      countEvent("tui:render:parallel");
      const renderStart = startSpan("tui:render:parallel");
      this.tuiData?._notify?.();
      endSpan("tui:render:parallel", renderStart);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — summary, review, completion, phase-change
  // ---------------------------------------------------------------------------

  private handleSummaryReady(summary: CompletionSummary): void {
    if (!this.tuiData) return;
    this.tuiData.completionSummary = summary;
    this.tuiData.engineState = "completed";
    this.tuiData.reviewStatus = "running";
    this.allowReview = true;
    this.allowFinalize = false;
    this.tuiData._onFinalize = this.allowFinalize ? () => {
      this.pipeline.submitAction({ requestId: "completion", key: "finalize" });
    } : undefined;
    this.tuiData._onReviewStart = this.allowReview ? () => {
      this.pipeline.submitAction({ requestId: "completion", key: "review" });
    } : undefined;
    this.renderSerial();
  }

  private handleReviewStatusChanged(status: "running" | "ready" | "complete" | "error", error?: string): void {
    if (!this.tuiData) return;
    this.tuiData.reviewStatus = status;
    if (error) this.tuiData.reviewError = error;
    if (status === "ready") {
      this.allowFinalize = true;
    }
    this.tuiData._onFinalize = this.allowFinalize ? () => {
      this.pipeline.submitAction({ requestId: "completion", key: "finalize" });
    } : undefined;
    this.renderSerial();
  }

  private handleExecutionCompleted(success: boolean): void {
    if (!this.tuiData) return;
    if (this.options.parallelMode) {
      this.tuiData.engineState = success ? "completed" : "paused";
      this.tuiData.currentPhase = success
        ? "Parallel execution completed"
        : "Parallel execution completed — some tasks failed";
      this.tuiData.phaseStartTime = Date.now();
      this.tuiData._notify?.();
    }
  }

  private handlePhaseChanged(phase: string): void {
    if (!this.tuiData) return;
    if (phase === "awaiting-action") {
      this.presentCompletionChoices();
    }
  }

  // ---------------------------------------------------------------------------
  // Private — awaiting-action flow
  // ---------------------------------------------------------------------------

  private presentCompletionChoices(): void {
    if (!this.tuiData) return;

    const submitAction = (action: "quit" | "finalize" | "review") => {
      const userAction: UserAction = {
        requestId: "completion",
        key: action,
      };
      this.pipeline.submitAction(userAction);
    };

    this.tuiData._onQuit = () => submitAction("quit");
    this.tuiData._onFinalize = this.allowFinalize ? () => submitAction("finalize") : undefined;
    this.tuiData._onReviewStart = this.allowReview ? () => submitAction("review") : undefined;
    this.renderSerial();
  }

  // ---------------------------------------------------------------------------
  // Private — rendering
  // ---------------------------------------------------------------------------

  private renderSerial(): void {
    if (!this.root || !this.tuiData || !this.SerialBridgeComponent) return;

    countEvent("tui:render:serial");
    const renderStart = performance.now();
    if (!this.serialBridgeRendered) {
      this.root.render(
        createElement(this.SerialBridgeComponent, {
          tuiData: this.tuiData,
          onQuit: () => {
            this.cleanup();
            process.exit(0);
          },
        }),
      );
      this.serialBridgeRendered = true;
    } else {
      this.tuiData._notify?.();
    }
    const notifyMs = performance.now() - renderStart;
    recordSpan("tui:render:serial:notify", notifyMs);
  }


  private renderParallel(): void {
    if (!this.root || !this.tuiData || !this.parallelState || !this.ParallelBridgeComponent) return;

    countEvent("tui:render:parallel");
    const renderStart = startSpan("tui:render:parallel");
    const logger = getLogger();
    this.root.render(
      createElement(this.ParallelBridgeComponent, {
        tuiData: this.tuiData,
        parallelState: this.parallelState,
        taskGraphAnalysis: this.options.taskGraphAnalysis!,
        onQuit: () => this.pipeline.stop(),
        onLogSubscribe: (cb: import("../logging/types.js").LogSubscriber) => logger.subscribe(cb),
      }),
    );
    endSpan("tui:render:parallel", renderStart);
  }

  private renderParallelThrottled(): void {
    if (this.parallelDestroyed || this.parallelRenderScheduled) return;
    this.parallelRenderScheduled = true;
    setTimeout(() => {
      this.parallelRenderScheduled = false;
      if (!this.parallelDestroyed) {
        countEvent("tui:render:parallel");
        const renderStart = startSpan("tui:render:parallel");
        this.tuiData?._notify?.();
        endSpan("tui:render:parallel", renderStart);
      }
    }, 33);
  }

  // ---------------------------------------------------------------------------
  // Private — historical iteration data (serial path)
  // ---------------------------------------------------------------------------

  private loadHistoricalIterationData(): void {
    const { sessionPaths, tasks } = this.options;
    const tuiData = this.tuiData;
    if (!tuiData) return;

    const completedTasks = tasks.filter((t) => t.status === "done");
    buildIterationMap(sessionPaths.progress).then(async (iterMap) => {
      if (!tuiData || iterMap.length === 0) return;
      for (const entry of iterMap) {
        tuiData.iterationEntries.push({
          iteration: entry.iteration,
          taskId: entry.taskId,
          status: "done",
          timestamp: 0,
        });
      }
      for (const task of completedTasks) {
        if (tuiData.taskOutputMap[task.id]) continue;
        const output = await loadTaskOutput(sessionPaths.logs, task.id, iterMap);
        if (output && !tuiData.taskOutputMap[task.id]) {
          tuiData.taskOutputMap[task.id] = output;
        }
      }
      this.renderSerial();
    });
  }
}
