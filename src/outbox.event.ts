export abstract class OutboxEvent {
  toPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) {
      payload[key] = value;
    }
    return payload;
  }

  getEventType(): string {
    const ctor = this.constructor as typeof OutboxEvent & {
      eventType?: string;
    };
    if (!ctor.eventType || typeof ctor.eventType !== 'string') {
      throw new Error(
        `${ctor.name} must define static readonly eventType: string`,
      );
    }
    return ctor.eventType;
  }
}
