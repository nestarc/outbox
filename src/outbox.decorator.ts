import { SetMetadata } from '@nestjs/common';
import { OUTBOX_EVENT_METADATA } from './outbox.constants';
import type { OutboxEvent } from './outbox.event';

type OutboxEventClass = { eventType: string } & (new (
  ...args: any[]
) => OutboxEvent);

export function OnOutboxEvent(...events: OutboxEventClass[]): MethodDecorator {
  const seen = new Set<string>();
  const eventTypes = events.map((e) => {
    if (!e.eventType || typeof e.eventType !== 'string') {
      throw new Error(
        `${e.name} must define static readonly eventType: string`,
      );
    }
    if (seen.has(e.eventType)) {
      throw new Error(
        `Duplicate outbox event type "${e.eventType}" in @OnOutboxEvent`,
      );
    }
    seen.add(e.eventType);
    return e.eventType;
  });
  return SetMetadata(OUTBOX_EVENT_METADATA, eventTypes);
}
