import type { Logger } from "./logger.js";
import type { EngineEvent, EngineEventListener } from "../engine/types.js";

const levelMap: Record<string, "debug" | "info" | "warn" | "error"> = {
  "agent:stdout": "debug",
  "agent:stderr": "debug",
  "agent:tool": "debug",
  "backpressure:start": "debug",
  "backpressure:pass": "debug",
  "iteration:start": "info",
  "iteration:end": "info",
  "task:start": "info",
  "task:complete": "info",
  "phase:scanning": "info",
  "phase:building-prompt": "info",
  "phase:spawning-agent": "info",
  "phase:waiting-response": "info",
  "phase:streaming": "info",
  "state:change": "info",
  "complete": "info",
  "ac:criteria-met": "info",
  "task:failed": "warn",
  "backpressure:fail": "warn",
  "rate-limit:detected": "warn",
  "circuit:trip": "error",
};

export function createEngineLogBridge(logger: Logger): EngineEventListener {
  const includeDebugLogs = process.env.SYNTH_DEBUG_ENGINE_LOGS === "1";
  return (event: EngineEvent): void => {
    const level = levelMap[event.type] ?? "info";
    if (level === "debug" && !includeDebugLogs) return;

    const meta: Record<string, unknown> = {};
    if (event.taskId !== undefined) meta.taskId = event.taskId;
    if (event.iteration !== undefined) meta.iteration = event.iteration;
    if (event.data !== undefined && includeDebugLogs) meta.data = event.data;
    if (event.criterionIndex !== undefined)
      meta.criterionIndex = event.criterionIndex;

    logger[level](
      event.type,
      event.message ?? event.type,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
  };
}
