// Task graph analysis
export { analyzeTaskGraph, recommendParallelism } from "./task-graph.js";
export type {
  ParallelismRecommendation,
  TaskGraphNode,
  ParallelGroup,
  TaskGraphAnalysis,
} from "./task-graph.js";

// Parallel events
export type {
  WorkerCreatedEvent,
  WorkerStartedEvent,
  WorkerCompletedEvent,
  WorkerFailedEvent,
  WorkerOutputEvent,
  MergeQueuedEvent,
  MergeStartedEvent,
  MergeCompletedEvent,
  MergeFailedEvent,
  ConflictDetectedEvent,
  ConflictAiResolvingEvent,
  ConflictResolvedEvent,
  ParallelStartedEvent,
  ParallelGroupStartedEvent,
  ParallelGroupCompletedEvent,
  ParallelCompletedEvent,
  ParallelFailedEvent,
  ParallelEvent,
  ParallelEventListener,
} from "./events.js";

// Worktree management
export { WorktreeManager, sanitizeBranchName } from "./worktree-manager.js";
export type {
  WorktreeInfo,
  WorktreeManagerOptions,
} from "./worktree-manager.js";

// Merge engine
export { MergeEngine } from "./merge-engine.js";
export type {
  WorkerResult,
  MergeOperation,
  MergeEngineOptions,
} from "./merge-engine.js";

// AI conflict resolution
export {
  tryFastPathResolution,
  buildConflictPrompt,
  extractResolvedContent,
  resolveWithAi,
} from "./ai-resolver.js";
export type { ConflictInfo, AiAgent } from "./ai-resolver.js";

// Coordinator (main orchestrator)
export { ParallelCoordinator } from "./coordinator.js";
export type {
  ParallelCoordinatorConfig,
  WorkerExecutor,
  ParallelCoordinatorOptions,
  ParallelResult,
} from "./coordinator.js";

// Session persistence
export {
  saveParallelSession,
  loadParallelSession,
  deleteParallelSession,
  findOrphanedWorktrees,
  cleanupOrphanedWorktrees,
} from "./session.js";
export type { ParallelSessionState } from "./session.js";
