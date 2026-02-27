import { useState, useCallback, useMemo, type ReactNode } from "react";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import type { TuiState } from "./types.js";
import { boldAttr, colors, statusIndicators, STATUS_COLORS_HEX } from "./theme.js";
import { Footer } from "./components/Footer.js";
import { startSpan, endSpan } from "./profiler.js";

interface HistoryEntry {
  iteration: number;
  taskId: string;
  status: string;
  relativeTime: string;
}

interface HistoryViewProps {
  state: TuiState;
  onBack: () => void;
}

function formatRelativeTime(timestamp: number): string {
  if (timestamp === 0) return "historical";
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function buildHistoryEntries(state: TuiState): HistoryEntry[] {
  return state.iterationEntries.map((entry) => ({
    iteration: entry.iteration,
    taskId: entry.taskId,
    status: entry.status,
    relativeTime: formatRelativeTime(entry.timestamp),
  }));
}

export function HistoryView({ state, onBack }: HistoryViewProps): ReactNode {
  const renderSpan = startSpan("HistoryView");
  const { width, height } = useTerminalDimensions();
  const listBodyHeight = Math.max(1, height - 5);
  const detailBodyHeight = Math.max(1, height - 2);
  const entries = useMemo(
    () => buildHistoryEntries(state),
    [state.iterationEntries],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState(false);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, entries.length - 1));
  const selectedEntry = entries[clampedIndex] ?? null;
  const detailOutput = selectedEntry
    ? (state.taskOutputMap[selectedEntry.taskId] ?? "")
    : "";

  const handleKey = useCallback(
    (key: { name: string }) => {
      if (detailMode) {
        if (key.name === "escape") {
          setDetailMode(false);
        }
        // j/k handled by scrollbox
        return;
      }

      switch (key.name) {
        case "j":
        case "down":
          setSelectedIndex((i) => Math.min(i + 1, entries.length - 1));
          break;
        case "k":
        case "up":
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "return":
          if (selectedEntry) setDetailMode(true);
          break;
        case "escape":
          onBack();
          break;
      }
    },
    [detailMode, entries.length, selectedEntry, onBack],
  );

  useKeyboard(handleKey);

  const detailLines = useMemo(() => {
    const outputText = detailOutput || "Log file not found";
    const isError = !detailOutput;
    return { outputText, isError, lines: outputText.split("\n") };
  }, [detailOutput]);

  if (detailMode && selectedEntry) {
    const { isError, lines } = detailLines;
    return (
      <box width={width} height={height} flexDirection="column">
        <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
          <text>
            <span fg={colors.accent.primary} attributes={boldAttr()}>History</span>
            <span fg={colors.fg.muted}>{" │ "}</span>
            <span fg={colors.fg.primary}>iter {selectedEntry.iteration} — {selectedEntry.taskId}</span>
            <span fg={colors.fg.muted}>{" │ "}</span>
            <span fg={isError ? colors.status.warning : colors.fg.secondary}>
              {isError ? "\u26A0 Log file not found" : "j/k:scroll  esc:back"}
            </span>
          </text>
        </box>
        <scrollbox height={detailBodyHeight} stickyScroll={false} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
          {lines.map((line, i) => (
            <text key={i}>
              <span fg={isError ? colors.status.warning : colors.fg.primary}>{line}</span>
            </text>
          ))}
        </scrollbox>
        <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
          <text>
            <span fg={colors.fg.muted}>esc:back to list  j/k:scroll</span>
          </text>
        </box>
      </box>
    );
  }

  endSpan("HistoryView", renderSpan);
  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1} style={{ backgroundColor: colors.bg.secondary, paddingLeft: 1 }}>
        <text>
          <span fg={colors.accent.primary} attributes={boldAttr()}>History</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.secondary}>{entries.length} iterations</span>
          <span fg={colors.fg.muted}>{" │ "}</span>
          <span fg={colors.fg.muted}>j/k:navigate  enter:view  esc:back</span>
        </text>
      </box>
      <text>{""}</text>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.fg.muted} attributes={boldAttr()}>
            {"#".padEnd(5)} {"Iter".padEnd(6)} {"Task ID".padEnd(12)} {"Status".padEnd(12)} Timestamp
          </span>
        </text>
      </box>
      <box style={{ paddingLeft: 1 }}>
        <text>
          <span fg={colors.border.normal}>{"\u2500".repeat(Math.min(width - 2, 60))}</span>
        </text>
      </box>
      {entries.length === 0 ? (
        <box style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.fg.muted}>No completed iterations yet.</span>
          </text>
        </box>
      ) : (
        <scrollbox height={listBodyHeight} stickyScroll={true} stickyStart="top" style={{ flexDirection: "column", paddingLeft: 1 }}>
          {entries.map((entry, i) => {
            const isSelected = i === clampedIndex;
            const icon = statusIndicators[entry.status as keyof typeof statusIndicators] ?? "?";
            const statusColor = STATUS_COLORS_HEX[entry.status as keyof typeof STATUS_COLORS_HEX] ?? colors.fg.muted;
            const bgStyle = isSelected ? { backgroundColor: colors.bg.highlight } : {};

            return (
              <box key={`${entry.taskId}-${entry.iteration}`} style={bgStyle}>
                <text>
                  <span fg={isSelected ? colors.accent.primary : colors.fg.muted}>{String(i + 1).padEnd(5)}</span>
                  <span fg={colors.fg.secondary}>{String(entry.iteration).padEnd(6)}</span>
                  <span fg={colors.fg.primary}>{entry.taskId.padEnd(12)}</span>
                  <span fg={statusColor}>{icon} {entry.status.padEnd(10)}</span>
                  <span fg={colors.fg.muted}>{entry.relativeTime}</span>
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}
      <Footer view="history" width={width} />
    </box>
  );
}
