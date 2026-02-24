export interface ReviewMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReviewFinding {
  severity: "critical" | "warning" | "info";
  title: string;
  file: string;
  lines?: string;
  description: string;
  suggestion: string;
}
