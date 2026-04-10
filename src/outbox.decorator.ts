import { SetMetadata } from '@nestjs/common';
import { OUTBOX_EVENT_METADATA } from './outbox.constants';
import type { OutboxEvent } from './outbox.event';

type OutboxEventClass = { eventType: string } & (new (
  ...args: any[]
) => OutboxEvent);

export function OnOutboxEvent(
  ...events: OutboxEventClass[]
): MethodDecorator {
  const eventTypes = events.map((e) => {
    if (!e.eventType || typeof e.eventType !== 'string') {
      throw new Error(
        `${e.name} must define static readonly eventType: string`,
      );
    }
    return e.eventType;
  });
  return SetMetadata(OUTBOX_EVENT_METADATA, eventTypes);
}
