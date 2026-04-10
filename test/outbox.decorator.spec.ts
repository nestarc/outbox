import { OUTBOX_EVENT_METADATA } from '../src/outbox.constants';
import { OnOutboxEvent } from '../src/outbox.decorator';
import { OutboxEvent } from '../src/outbox.event';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
}

class OrderPaidEvent extends OutboxEvent {
  static readonly eventType = 'order.paid';
}

class NoEventTypeEvent extends OutboxEvent {}

describe('@OnOutboxEvent', () => {
  it('should set metadata with a single event type', () => {
    class TestHandler {
      @OnOutboxEvent(OrderCreatedEvent)
      handle() {}
    }

    const metadata = Reflect.getMetadata(
      OUTBOX_EVENT_METADATA,
      TestHandler.prototype.handle,
    );
    expect(metadata).toEqual(['order.created']);
  });

  it('should set metadata with multiple event types', () => {
    class TestHandler {
      @OnOutboxEvent(OrderCreatedEvent, OrderPaidEvent)
      handle() {}
    }

    const metadata = Reflect.getMetadata(
      OUTBOX_EVENT_METADATA,
      TestHandler.prototype.handle,
    );
    expect(metadata).toEqual(['order.created', 'order.paid']);
  });

  it('should throw if event class has no static eventType', () => {
    expect(() => {
      class TestHandler {
        @OnOutboxEvent(NoEventTypeEvent as any)
        handle() {}
      }
    }).toThrow('NoEventTypeEvent must define static readonly eventType');
  });
});
