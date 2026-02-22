export class CircuitBreaker {
  private consecutiveFailures = 0;
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): boolean {
    this.consecutiveFailures++;
    return this.isTripped();
  }

  isTripped(): boolean {
    return this.consecutiveFailures >= this.threshold;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}
