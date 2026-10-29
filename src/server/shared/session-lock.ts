/** Per-key mutex: work for the same session runs one at a time, in order. */
export function createSessionLock() {
  const tails = new Map<string, Promise<void>>();

  /** Resolves when the caller holds the lock; call the returned function to release it. */
  async function acquire(key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  }

  async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const release = await acquire(key);
    try {
      return await task();
    } finally {
      release();
    }
  }

  return { acquire, run };
}
