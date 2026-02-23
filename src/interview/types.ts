export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InterviewState {
  messages: InterviewMessage[];
  interviewerHistory: InterviewMessage[];
  prdPending: boolean;
}

export interface GeneratedPrd {
  title: string;
  problemStatement: string;
  goals: string[];
  targetUsers: string;
  scope: {
    included: string[];
    excluded: string[];
  };
  userStories: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
  }[];
  qualityGates: string[];
}
