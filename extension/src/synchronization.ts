/** Coalesce invalidations and never apply a response superseded while it was loading. */
export function synchronizedRefresh<T>(read: () => Promise<T>, apply: (value: T) => void, failed: (error: unknown) => void) {
  let revision = 0;
  let running: Promise<void> | undefined;
  let disposed = false;
  function refresh(): Promise<void> {
    revision++;
    if (disposed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      let started: number;
      do {
        started = revision;
        try {
          const value = await read();
          if (!disposed && started === revision) apply(value);
        } catch (error) { if (!disposed && started === revision) failed(error); }
      } while (!disposed && started !== revision);
    })().finally(() => { running = undefined; });
    return running;
  }
  return { refresh, dispose() { disposed = true; } };
}
