export interface DoctorCheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  suggestion?: string;
}
