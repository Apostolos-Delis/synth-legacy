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
  WorkerProgressEvent,
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

// Conflict resolver (orchestrates three-way merge resolution pipeline)
export { resolveConflicts, wrapAgentAsAiAgent } from "./conflict-resolver.js";
export type { ConflictResolutionResult } from "./conflict-resolver.js";

// Worker (wraps Engine for parallel execution)
export { Worker } from "./worker.js";
export type {
  WorkerConfig,
  WorkerStatus,
  WorkerDisplayState,
} from "./worker.js";

// Coordinator (main orchestrator)
export { ParallelCoordinator } from "./coordinator.js";
export type {
  ParallelCoordinatorConfig,
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
