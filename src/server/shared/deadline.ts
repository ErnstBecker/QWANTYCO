export class DeadlineError extends Error {
  constructor() {
    super("Deadline exceeded");
    this.name = "DeadlineError";
  }
}

/**
 * Runs a task with a hard deadline. The task receives an AbortSignal to cancel
 * its own work, but the deadline is enforced even if the task ignores it.
 */
export async function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new DeadlineError());
      },
      Math.max(0, Math.ceil(ms)),
    );
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
