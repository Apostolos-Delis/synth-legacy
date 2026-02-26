export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
  durationMs?: number;
}

export interface InterviewState {
  messages: InterviewMessage[];
  interviewerHistory: InterviewMessage[];
  prdPending: boolean;
}
