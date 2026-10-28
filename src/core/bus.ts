import type { StreamMessage } from "./types";

type Listener = (message: StreamMessage) => void;

/** In-process pub/sub. Every state change is published here; SSE and notifications subscribe. */
export class Bus {
  private listeners = new Set<Listener>();

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
