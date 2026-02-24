export interface ConflictInfo {
  file: string;
  base: string;
  ours: string;
  theirs: string;
  taskId: string;
  taskTitle: string;
}

export interface AiAgent {
  resolve(prompt: string, cwd: string): Promise<string>;
}

export function tryFastPathResolution(
  base: string,
  ours: string,
  theirs: string,
): string | null {
  if (ours === theirs) return ours;
  if (ours === "" || ours === base) return theirs;
  if (theirs === "" || theirs === base) return ours;
  return null;
}

export function buildConflictPrompt(
  file: string,
  base: string,
  ours: string,
  theirs: string,
  taskId: string,
  taskTitle: string,
): string {
  return [
    `Resolve the merge conflict in \`${file}\` for task ${taskId}: ${taskTitle}.`,
    "",
    "<<<< BASE",
    base,
    "==== OURS",
    ours,
    "==== THEIRS",
    theirs,
    ">>>> END",
    "",
    "Return ONLY the resolved file content, no explanation.",
  ].join("\n");
}

export function extractResolvedContent(agentOutput: string): string {
  const fencePattern = /^```[\w]*\n?([\s\S]*?)\n?```$/;
  const match = agentOutput.trim().match(fencePattern);
  return match ? match[1] : agentOutput;
}

export async function resolveWithAi(
  conflictInfo: ConflictInfo,
  agent: AiAgent,
  cwd: string,
): Promise<string | null> {
  const fastPath = tryFastPathResolution(
    conflictInfo.base,
    conflictInfo.ours,
    conflictInfo.theirs,
  );
  if (fastPath !== null) return fastPath;

  const prompt = buildConflictPrompt(
    conflictInfo.file,
    conflictInfo.base,
    conflictInfo.ours,
    conflictInfo.theirs,
    conflictInfo.taskId,
    conflictInfo.taskTitle,
  );

  const output = await agent.resolve(prompt, cwd);
  return extractResolvedContent(output);
}
