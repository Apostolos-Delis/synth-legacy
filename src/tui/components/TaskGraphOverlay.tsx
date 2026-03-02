import { memo, useMemo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TaskGraphAnalysis, TaskGraphNode } from "../../parallel/task-graph.js";
import type { Task } from "../../tasks/types.js";
import {
  colors,
  SPINNER_FRAMES,
  STATUS_COLORS_HEX,
  statusIndicators,
} from "../theme.js";
import { useAnimationTick } from "../hooks/useAnimationTick.js";

export interface TaskGraphOverlayProps {
  visible: boolean;
  analysis: TaskGraphAnalysis;
  taskStatuses: Record<string, Task["status"]>;
}

// Fixed width for each node cell (including padding between nodes)
const NODE_PAD = 2;
const MIN_OVERLAY_WIDTH = 40;

function statusIcon(status: Task["status"], spinnerFrame: number): string {
  if (status === "in_progress") return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  return statusIndicators[status] ?? "?";
}

function statusColor(status: Task["status"]): string {
  return STATUS_COLORS_HEX[status] ?? colors.fg.muted;
}

/** Render a single task node: "icon ID" */
function TaskNode({
  taskId,
  status,
  spinnerFrame,
  maxLabelWidth,
}: {
  taskId: string;
  status: Task["status"];
  spinnerFrame: number;
  maxLabelWidth: number;
}): ReactNode {
  const icon = statusIcon(status, spinnerFrame);
  const fg = statusColor(status);
  const label = taskId.length > maxLabelWidth
    ? taskId.slice(0, maxLabelWidth - 1) + "\u2026"
    : taskId;

  return (
    <box style={{ flexDirection: "row", marginRight: NODE_PAD }}>
      <text>
        <span fg={colors.border.normal}>[</span>
        <span fg={fg}>{icon}</span>
        <span fg={colors.fg.primary}> {label}</span>
        <span fg={colors.border.normal}>]</span>
      </text>
    </box>
  );
}

/** Build connector lines between two adjacent waves using box-drawing characters */
function ConnectorRow({
  parentGroup,
  childGroup,
  nodes,
  nodeWidth,
  maxNodesPerRow,
}: {
  parentGroup: string[];
  childGroup: string[];
  nodes: Map<string, TaskGraphNode>;
  nodeWidth: number;
  maxNodesPerRow: number;
}): ReactNode {
  // Find which parent positions connect to which child positions
  const connections: Array<{ parentIdx: number; childIdx: number }> = [];

  for (let ci = 0; ci < childGroup.length; ci++) {
    const childNode = nodes.get(childGroup[ci]);
    if (!childNode) continue;
    for (const dep of childNode.dependsOn) {
      const pi = parentGroup.indexOf(dep);
      if (pi !== -1) {
        connections.push({ parentIdx: pi, childIdx: ci });
      }
    }
  }

  if (connections.length === 0) {
    return <text fg={colors.fg.dim}>{"  \u2502"}</text>;
  }

  // Build two connector lines:
  // Line 1: vertical pipes down from parents
  // Line 2: horizontal connections + corners to children
  const totalWidth = maxNodesPerRow * nodeWidth;

  // Center of a node at index i: i * nodeWidth + nodeWidth/2
  const centerOf = (idx: number) => idx * nodeWidth + Math.floor(nodeWidth / 2);

  // Line 1: pipes from parent centers
  const line1 = new Array(totalWidth).fill(" ");
  const parentPositions = new Set<number>();
  for (const c of connections) {
    const pos = centerOf(c.parentIdx);
    if (pos < totalWidth) {
      line1[pos] = "\u2502"; // │
      parentPositions.add(pos);
    }
  }

  // Line 2: horizontal spans connecting parents to children
  const line2 = new Array(totalWidth).fill(" ");
  const childPositions = new Set<number>();
  for (const c of connections) {
    const pos = centerOf(c.childIdx);
    childPositions.add(pos);
  }

  // For each connection, draw from parent center down to child center
  // Group by child to handle multiple parents → one child
  const childToParents = new Map<number, number[]>();
  for (const c of connections) {
    const cp = centerOf(c.childIdx);
    const pp = centerOf(c.parentIdx);
    if (!childToParents.has(cp)) childToParents.set(cp, []);
    childToParents.get(cp)!.push(pp);
  }

  for (const [cp, pps] of childToParents) {
    const minP = Math.min(...pps, cp);
    const maxP = Math.max(...pps, cp);
    for (let i = minP; i <= maxP && i < totalWidth; i++) {
      if (line2[i] === " ") line2[i] = "\u2500"; // ─
    }
    // Place corners/junctions
    if (cp < totalWidth) {
      if (pps.some((p) => p < cp)) {
        line2[cp] = "\u2534"; // ┴ (line comes from left, goes up)
      } else if (pps.some((p) => p > cp)) {
        line2[cp] = "\u2534"; // ┴
      } else {
        line2[cp] = "\u2502"; // │ straight down
      }
    }
    for (const pp of pps) {
      if (pp < totalWidth && pp !== cp) {
        if (pp < cp) {
          line2[pp] = line2[pp] === "\u2500" ? "\u2510" : "\u252C"; // ┐ or ┬
        } else {
          line2[pp] = line2[pp] === "\u2500" ? "\u250C" : "\u252C"; // ┌ or ┬
        }
      }
    }
  }

  // For single straight-down connections (parent directly above child), simplify
  for (const [cp, pps] of childToParents) {
    if (pps.length === 1 && pps[0] === cp && cp < totalWidth) {
      line2[cp] = "\u2502"; // │
    }
  }

  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={colors.fg.dim}>{" " + line1.join("")}</text>
      <text fg={colors.fg.dim}>{" " + line2.join("")}</text>
    </box>
  );
}

export const TaskGraphOverlay = memo(function TaskGraphOverlay({
  visible,
  analysis,
  taskStatuses,
}: TaskGraphOverlayProps): ReactNode {
  const { width: termWidth } = useTerminalDimensions();

  const hasRunning = useMemo(
    () => Object.values(taskStatuses).some((s) => s === "in_progress"),
    [taskStatuses],
  );
  const tickState = useAnimationTick(hasRunning && visible);
  const spinnerFrame = hasRunning && visible ? tickState.spinnerFrame : 0;

  const isNarrow = termWidth < MIN_OVERLAY_WIDTH;

  // Compute max ID length across all tasks for consistent node widths
  const allTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const g of analysis.groups) ids.push(...g.taskIds);
    ids.push(...analysis.cyclicTaskIds);
    return ids;
  }, [analysis]);

  const maxIdLen = useMemo(
    () => allTaskIds.reduce((max, id) => Math.max(max, id.length), 0),
    [allTaskIds],
  );

  // Node display width: [icon ID] + padding → "[ " + icon + " " + id + "]" + pad
  const maxLabelWidth = isNarrow ? Math.min(maxIdLen, 8) : maxIdLen;
  const nodeWidth = maxLabelWidth + 5 + NODE_PAD; // [X ID] = 4 + idLen + pad

  const maxNodesPerRow = useMemo(
    () => analysis.groups.reduce((max, g) => Math.max(max, g.taskIds.length), 0),
    [analysis],
  );

  if (!visible) return null;

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#000000B3",
      }}
    >
      <box
        style={{
          flexDirection: "column",
          padding: 2,
          backgroundColor: colors.bg.secondary,
          borderColor: colors.accent.primary,
          minWidth: MIN_OVERLAY_WIDTH,
          maxWidth: Math.min(termWidth - 4, 80),
        }}
        border
      >
        {/* Title */}
        <box style={{ marginBottom: 1, justifyContent: "center" }}>
          <text fg={colors.accent.primary}>Task Dependency Graph</text>
        </box>

        {isNarrow && (
          <box style={{ marginBottom: 1, justifyContent: "center" }}>
            <text fg={colors.status.warning}>
              {"\u26A0 Terminal too narrow \u2014 resize for full view"}
            </text>
          </box>
        )}

        {/* Wave rows with connectors */}
        {analysis.groups.map((group, gi) => (
          <box key={group.depth} style={{ flexDirection: "column" }}>
            {/* Wave header */}
            <text fg={colors.fg.muted}>
              {"\u2500\u2500 Wave " + group.depth + " " + "\u2500".repeat(Math.max(0, maxNodesPerRow * nodeWidth - 10))}
            </text>

            {/* Task nodes in a row */}
            <box style={{ flexDirection: "row", marginLeft: 1 }}>
              {group.taskIds.map((taskId) => (
                <TaskNode
                  key={taskId}
                  taskId={taskId}
                  status={taskStatuses[taskId] ?? "open"}
                  spinnerFrame={spinnerFrame}
                  maxLabelWidth={maxLabelWidth}
                />
              ))}
            </box>

            {/* Connector to next wave */}
            {gi < analysis.groups.length - 1 && (
              <ConnectorRow
                parentGroup={group.taskIds}
                childGroup={analysis.groups[gi + 1].taskIds}
                nodes={analysis.nodes}
                nodeWidth={nodeWidth}
                maxNodesPerRow={maxNodesPerRow}
              />
            )}
          </box>
        ))}

        {/* Cyclic tasks section */}
        {analysis.cyclicTaskIds.length > 0 && (
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={colors.status.warning}>
              {"\u26A0 Cyclic Dependencies"}
            </text>
            <box style={{ flexDirection: "row", marginLeft: 1, flexWrap: "wrap" }}>
              {analysis.cyclicTaskIds.map((taskId) => (
                <TaskNode
                  key={taskId}
                  taskId={taskId}
                  status={taskStatuses[taskId] ?? "open"}
                  spinnerFrame={spinnerFrame}
                  maxLabelWidth={maxLabelWidth}
                />
              ))}
            </box>
          </box>
        )}

        {/* Footer */}
        <box style={{ marginTop: 1, justifyContent: "center" }}>
          <text fg={colors.fg.muted}>g:close graph  Esc:close</text>
        </box>
      </box>
    </box>
  );
});
