export interface OutboxHandler {
  instance: Record<string, any>;
  methodName: string;
  eventTypes: string[];
}
