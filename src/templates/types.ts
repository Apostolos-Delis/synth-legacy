export interface TemplateVariables {
  agentName: string;
  model?: string;
  cwd: string;
  currentDate: string;
  slug: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  priority: number;
  projectContext?: string;
  codebasePatterns?: string;
  recentProgress?: string;
  iteration: number;
  verification?: { type: string; value: string }[];
  notes?: string;
}

export interface TemplateLoadResult {
  source: "explicit" | "project" | "global" | "builtin" | "builtin-default";
  path?: string;
  template: string;
}

export interface TemplateRenderResult {
  rendered: string;
  source: TemplateLoadResult["source"];
  path?: string;
}
