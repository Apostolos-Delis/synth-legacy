import { SPINNER_FRAMES, ansi } from "./theme.js";

export interface SpinnerHandle {
  stop(msg: string): void;
  update(label: string): void;
}

export function createSpinner(label: string): SpinnerHandle {
  let frame = 0;
  let currentLabel = label;

  const interval = setInterval(() => {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1b[K${ansi.primary}${spinner}${ansi.reset} ${currentLabel}`);
    frame++;
  }, 80);

  return {
    stop(msg: string) {
      clearInterval(interval);
      process.stdout.write(`\r\x1b[K${msg}\n`);
    },
    update(newLabel: string) {
      currentLabel = newLabel;
    },
  };
}

export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { successMessage?: string; errorMessage?: string },
): Promise<T> {
  const spinner = createSpinner(label);
  try {
    const result = await fn();
    spinner.stop(opts?.successMessage ?? `${ansi.success}\u2713${ansi.reset} ${label}`);
    return result;
  } catch (err) {
    spinner.stop(opts?.errorMessage ?? `${ansi.error}\u2717${ansi.reset} ${label}`);
    throw err;
  }
}
