const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /too many requests/i,
  /quota exceeded/i,
  /retry.?after/i,
  /overloaded/i,
  /capacity/i,
];

export function detectRateLimit(output: string): boolean {
  const tail = output.length > 2000 ? output.slice(-2000) : output;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(tail));
}

export function getBackoffDelay(attempt: number): number {
  // Exponential backoff: 5s, 10s, 20s, 40s, 80s (capped at 120s)
  const base = 5000;
  const delay = base * Math.pow(2, attempt);
  return Math.min(delay, 120_000);
}
