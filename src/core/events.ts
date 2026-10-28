import type { Bus } from "./bus";
import type { Store } from "./db";
import type { AppEvent, NewEvent } from "./types";

export type EventSink = (event: AppEvent) => void;

/** Persists an event, publishes it on the bus, and hands it to the notifier. */
export class Events {
  private sinks = new Set<EventSink>();

  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  onEvent(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  emit(event: NewEvent): AppEvent {
    const saved = this.store.addEvent(event);
    this.bus.publish({ type: "event", event: saved });
    for (const sink of this.sinks) {
      try {
        sink(saved);
      } catch (error) {
        console.error("event sink failed", error);
      }
    }
    return saved;
  }
}
