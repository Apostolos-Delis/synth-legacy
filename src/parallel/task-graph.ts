import type { Task } from "../tasks/types.js";

export interface ParallelismRecommendation {
  recommendedWorkers: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface TaskGraphNode {
  taskId: string;
  depth: number;
  dependsOn: string[];
  dependedBy: string[];
}

export interface ParallelGroup {
  depth: number;
  taskIds: string[];
}

export interface TaskGraphAnalysis {
  groups: ParallelGroup[];
  cyclicTaskIds: string[];
  maxParallelism: number;
  recommendParallel: boolean;
  nodes: Map<string, TaskGraphNode>;
}

const ACTIONABLE_STATUSES = new Set<Task["status"]>(["open", "in_progress"]);

export function analyzeTaskGraph(tasks: Task[]): TaskGraphAnalysis {
  const actionable = tasks.filter((t) => ACTIONABLE_STATUSES.has(t.status));
  const taskIds = new Set(actionable.map((t) => t.id));

  // Build adjacency: inDegree and edges scoped to actionable tasks
  const inDegree = new Map<string, number>();
  const dependedBy = new Map<string, string[]>();
  const dependsOnMap = new Map<string, string[]>();

  for (const t of actionable) {
    inDegree.set(t.id, 0);
    dependedBy.set(t.id, []);
    dependsOnMap.set(t.id, []);
  }

  for (const t of actionable) {
    if (t.dependsOn) {
      for (const dep of t.dependsOn) {
        if (!taskIds.has(dep)) continue; // skip deps on non-actionable tasks
        dependsOnMap.get(t.id)!.push(dep);
        dependedBy.get(dep)!.push(t.id);
        inDegree.set(t.id, inDegree.get(t.id)! + 1);
      }
    }
  }

  // Kahn's algorithm for topological sort with depth tracking
  const queue: string[] = [];
  const depth = new Map<string, number>();

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      depth.set(id, 0);
    }
  }

  const sorted: string[] = [];
  let qi = 0;

  while (qi < queue.length) {
    const current = queue[qi++];
    sorted.push(current);

    for (const neighbor of dependedBy.get(current)!) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);
      const candidateDepth = depth.get(current)! + 1;
      depth.set(neighbor, Math.max(depth.get(neighbor) ?? 0, candidateDepth));
      if (newDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Any task not in sorted is part of a cycle
  const cyclicTaskIds = actionable
    .map((t) => t.id)
    .filter((id) => !sorted.includes(id));

  // Build groups from depth map (only non-cyclic tasks)
  const groupMap = new Map<number, string[]>();
  for (const id of sorted) {
    const d = depth.get(id)!;
    if (!groupMap.has(d)) groupMap.set(d, []);
    groupMap.get(d)!.push(id);
  }

  const groups: ParallelGroup[] = [...groupMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([d, ids]) => ({ depth: d, taskIds: ids }));

  const maxParallelism = groups.reduce(
    (max, g) => Math.max(max, g.taskIds.length),
    0,
  );

  const actionableCount = sorted.length;
  const hasParallelGroup = groups.some((g) => g.taskIds.length >= 2);
  const recommendParallel = actionableCount >= 3 && hasParallelGroup;

  // Build node map for all actionable tasks (including cyclic)
  const nodes = new Map<string, TaskGraphNode>();
  for (const t of actionable) {
    nodes.set(t.id, {
      taskId: t.id,
      depth: depth.get(t.id) ?? -1,
      dependsOn: dependsOnMap.get(t.id)!,
      dependedBy: dependedBy.get(t.id)!,
    });
  }

  return {
    groups,
    cyclicTaskIds,
    maxParallelism,
    recommendParallel,
    nodes,
  };
}

export function recommendParallelism(
  tasks: Task[],
  analysis: TaskGraphAnalysis,
  defaultMax: number,
): ParallelismRecommendation {
  const clamp = (n: number) => Math.max(1, Math.min(defaultMax, Math.round(n)));

  // Collect tasks that appear in parallel groups and have affects data
  const groupTaskIds = new Set(analysis.groups.flatMap((g) => g.taskIds));
  const tasksInGroups = tasks.filter((t) => groupTaskIds.has(t.id));
  const tasksWithAffects = tasksInGroups.filter(
    (t) => t.affects && t.affects.length > 0,
  );

  if (tasksWithAffects.length === 0) {
    return {
      recommendedWorkers: clamp(defaultMax),
      confidence: "low",
      reason: "No affects data available to analyze file overlap",
    };
  }

  // Count tasks that share at least one file with another task
  let tasksWithOverlap = 0;
  for (let i = 0; i < tasksWithAffects.length; i++) {
    const filesA = new Set(tasksWithAffects[i].affects!);
    let shares = false;
    for (let j = 0; j < tasksWithAffects.length; j++) {
      if (i === j) continue;
      if (tasksWithAffects[j].affects!.some((f) => filesA.has(f))) {
        shares = true;
        break;
      }
    }
    if (shares) tasksWithOverlap++;
  }

  const overlapRatio = tasksWithOverlap / tasksWithAffects.length;

  if (overlapRatio === 0) {
    return {
      recommendedWorkers: clamp(defaultMax),
      confidence: "high",
      reason: "All tasks affect disjoint files",
    };
  }

  if (overlapRatio > 0.3) {
    return {
      recommendedWorkers: clamp(Math.floor(defaultMax * 0.5)),
      confidence: "medium",
      reason: `${Math.round(overlapRatio * 100)}% of tasks share affected files; reducing parallelism`,
    };
  }

  // Some overlap but ≤30%
  return {
    recommendedWorkers: clamp(defaultMax),
    confidence: "medium",
    reason: `${Math.round(overlapRatio * 100)}% of tasks share affected files; within safe threshold`,
  };
}
