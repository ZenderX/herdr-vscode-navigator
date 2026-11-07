export interface ConfigQueueDeps {
  /** Waits before a retry; the VS Code binding owns the interval. */
  delay: () => Promise<void>;
}

export interface ConfigQueue {
  /** Runs `fn` after every earlier call has settled; a rejection is retried up to `retries` times (default none), then rejects with the last error. */
  run<T>(fn: () => Thenable<T>, retries?: number): Promise<T>;
}

/** One queue per extension host: VS Code serializes setting edits against each other but not against folder edits, and an `update` can reject. */
export function createConfigQueue({ delay }: ConfigQueueDeps): ConfigQueue {
  let tail: Promise<unknown> = Promise.resolve();

  const attempt = async <T>(fn: () => Thenable<T>, retries: number): Promise<T> => {
    for (let left = retries; ; left--) {
      try {
        return await fn();
      } catch (err: unknown) {
        if (left <= 0) throw err;
        await delay();
      }
    }
  };

  return {
    run<T>(fn: () => Thenable<T>, retries = 0): Promise<T> {
      const next = (): Promise<T> => attempt(fn, retries);
      // An earlier rejection belongs to its own caller; it must not stop this write.
      const result = tail.then(next, next);
      tail = result;
      return result;
    },
  };
}
