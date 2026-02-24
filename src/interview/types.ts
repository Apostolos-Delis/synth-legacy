export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InterviewState {
  messages: InterviewMessage[];
  interviewerHistory: InterviewMessage[];
  prdPending: boolean;
}
