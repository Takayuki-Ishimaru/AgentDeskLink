/** Bounded counters for actual attempts. Only fixed stage names and durations are retained. */
export class StartupDiagnostics {
  private attempts = 0;
  private successful = 0;
  private running = 0;
  private first: boolean | undefined;
  private last:
    | { outcome: 'running' | 'succeeded' | 'failed'; stages_ms: Record<string, number>; failed_stage?: string }
    | undefined;
  start() {
    this.attempts++;
    this.running++;
    const attempt = this.attempts;
    const record: NonNullable<StartupDiagnostics['last']> = { outcome: 'running', stages_ms: {} };
    this.last = record;
    let clock = performance.now(),
      stage = 'initialization',
      ended = false;
    return {
      stage: (name: string) => {
        const now = performance.now();
        record.stages_ms[stage] = Math.round(now - clock);
        clock = now;
        stage = name;
      },
      finish: (success: boolean) => {
        if (ended) return;
        ended = true;
        this.running--;
        record.stages_ms[stage] = Math.round(performance.now() - clock);
        record.outcome = success ? 'succeeded' : 'failed';
        if (!success) record.failed_stage = stage;
        if (attempt === 1) this.first = success;
        if (success) this.successful++;
      },
    };
  }
  snapshot() {
    return {
      attempts: this.attempts,
      successful: this.successful,
      failed: this.attempts - this.successful - this.running,
      running: this.running,
      ...(this.first !== undefined ? { first_attempt_succeeded: this.first } : {}),
      ...(this.last ? { last: structuredClone(this.last) } : {}),
    };
  }
}
