import type { StreamMessage } from "./types";

type Listener = (message: StreamMessage) => void;

/** In-process pub/sub. Every state change is published here; SSE and notifications subscribe. */
export class Bus {
  private listeners = new Set<Listener>();
  private closers = new Set<() => void>();
  private closed = false;

  /** Runs when the app stops (shutdown or a mode restart). Event streams use it to end so clients reconnect. */
  onClose(fn: () => void): () => void {
    if (this.closed) {
      fn();
      return () => {};
    }
    this.closers.add(fn);
    return () => this.closers.delete(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of [...this.closers]) {
      try {
        fn();
      } catch {}
    }
    this.closers.clear();
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: StreamMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("bus listener failed", error);
      }
    }
  }
}
