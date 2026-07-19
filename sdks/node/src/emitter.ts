import type { Logger } from './types.js';

type Listener<T> = (payload: T) => void;

/**
 * A tiny internal event emitter for `EnvpitClient#on()` — deliberately NOT Node's
 * `EventEmitter`. Per `outputs/SPEC-envpit-a9d-1b-ux.md` §3.1 principle 4: a listener
 * exception must never crash the host app, and — critically — this emitter must NOT inherit
 * `EventEmitter`'s "an unhandled `'error'` event throws" semantics. That behavior would
 * convert a transient network blip into a process crash for any developer who subscribed to
 * `change` but not `error` — exactly what AC-4/AC-U7 forbid. Every event, including `error`,
 * is fire-and-forget here: a listener that throws is caught, reported through the injected
 * `Logger` (never rethrown), and every OTHER listener for that event still runs.
 */
export class SafeEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  constructor(private readonly logger?: Logger) {}

  /** Subscribes `listener` to `event`. Returns an idempotent unsubscribe function. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      set?.delete(listener as Listener<unknown>);
    };
  }

  /** Runs every listener registered for `event`, in subscription order. A throwing listener —
   *  synchronous OR async (a returned promise that rejects) — is caught and logged; it never
   *  stops the remaining listeners from running, and never propagates to the caller of
   *  `emit()`, and never becomes an unhandled promise rejection (which would otherwise crash
   *  the host process by default in Node — bd:envpit-r59g). `Listener<T>`'s declared return
   *  type is `void`, but nothing stops a caller from passing an `async` function (TS's
   *  void-return-type rule permits it); we defensively check the actual runtime return value
   *  for a thenable regardless of what the type says. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        // Invoked through an `unknown`-returning view so a listener's actual runtime return
        // value (e.g. a rejecting Promise from an `async` listener) is observable here, even
        // though the public `Listener<T>` type says `void`.
        const invoke = listener as unknown as (payload: Events[K]) => unknown;
        const result = invoke(payload);
        if (isThenable(result)) {
          Promise.resolve(result).catch((err: unknown) => this.reportListenerError(event, err));
        }
      } catch (err) {
        this.reportListenerError(event, err);
      }
    }
  }

  private reportListenerError<K extends keyof Events>(event: K, err: unknown): void {
    this.logger?.error?.(
      `envpit: a config event listener threw (event: ${String(event)}): ${describeThrown(err)}`,
    );
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
