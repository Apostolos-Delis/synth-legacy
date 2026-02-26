import { memo, useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import type { LogEntry, LogSubscriber } from "../logging/types.js";
import { colors, boldAttr } from "./theme.js";

const MAX_ENTRIES = 10_000;

const LEVEL_COLORS: Record<string, string> = {
  debug: colors.fg.muted,
  info: colors.status.info,
  warn: colors.status.warning,
  error: colors.status.error,
};

const LEVEL_LABELS: Record<string, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

interface LogViewProps {
  width: number;
  height: number;
  focused?: boolean;
  filter?: string;
  onSubscribe?: (subscriber: LogSubscriber) => () => void;
}

export const LogView = memo(function LogView({
  width,
  height,
  focused = false,
  filter,
  onSubscribe,
}: LogViewProps): ReactNode {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const bufferRef = useRef<LogEntry[]>([]);

  const handleEntry = useCallback((entry: LogEntry) => {
    const buf = bufferRef.current;
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) {
      const excess = buf.length - MAX_ENTRIES;
      buf.splice(0, excess);
    }
    setEntries([...buf]);
  }, []);

  useEffect(() => {
    if (!onSubscribe) return;
    const unsubscribe = onSubscribe(handleEntry);
    return unsubscribe;
  }, [onSubscribe, handleEntry]);

  const normalizedFilter = (filter ?? "").trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    if (!normalizedFilter) return entries;
    return entries.filter((entry) => {
      if (entry.message.toLowerCase().includes(normalizedFilter)) return true;
      if (entry.event && entry.event.toLowerCase().includes(normalizedFilter)) return true;
      if (entry.level.toLowerCase().includes(normalizedFilter)) return true;
      return false;
    });
  }, [entries, normalizedFilter]);

  return (
    <box
      width={width}
      height={height}
      border={true}
      borderColor={focused ? colors.border.active : colors.border.normal}
      title="Logs"
      flexDirection="column"
      overflow="hidden"
    >
      {filteredEntries.length === 0 ? (
        <box flexGrow={1} style={{ paddingLeft: 1 }}>
          <text>
            <span fg={colors.fg.muted}>
              {normalizedFilter ? "No log entries match the filter." : "No log entries yet."}
            </span>
          </text>
        </box>
      ) : (
        <scrollbox
          flexGrow={1}
          focused={focused}
          stickyScroll={true}
          stickyStart="bottom"
          style={{ flexDirection: "column" }}
        >
          {filteredEntries.map((entry, i) => {
            const levelColor = LEVEL_COLORS[entry.level] ?? colors.fg.muted;
            const label = LEVEL_LABELS[entry.level] ?? entry.level.toUpperCase();
            const hasEvent = Boolean(entry.event && entry.event.trim() !== "");
            return (
              <text key={i} truncate={true}>
                <span fg={colors.fg.muted}>{formatTimestamp(entry.timestamp)}</span>
                {" "}
                <span fg={levelColor} attributes={boldAttr()}>{label}</span>
                {hasEvent ? (
                  <>
                    {" "}
                    <span fg={colors.accent.secondary}>{entry.event}</span>
                  </>
                ) : null}
                {" "}
                <span fg={colors.fg.primary}>{entry.message}</span>
              </text>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
});
