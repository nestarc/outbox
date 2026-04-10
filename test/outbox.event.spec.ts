import { OutboxEvent } from '../src/outbox.event';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class MissingEventTypeEvent extends OutboxEvent {}

describe('OutboxEvent', () => {
  describe('getEventType', () => {
    it('should return the static eventType from the subclass', () => {
      const event = new OrderCreatedEvent('order-1', 100);
      expect(event.getEventType()).toBe('order.created');
    });

    it('should throw if static eventType is not defined', () => {
      const event = new MissingEventTypeEvent();
      expect(() => event.getEventType()).toThrow(
        'MissingEventTypeEvent must define static readonly eventType',
      );
    });
  });

  describe('toPayload', () => {
    it('should return all own enumerable properties', () => {
      const event = new OrderCreatedEvent('order-1', 100);
      expect(event.toPayload()).toEqual({
        orderId: 'order-1',
        total: 100,
      });
    });

    it('should return empty object for event with no properties', () => {
      class EmptyEvent extends OutboxEvent {
        static readonly eventType = 'empty';
      }
      const event = new EmptyEvent();
      expect(event.toPayload()).toEqual({});
    });
  });
});
