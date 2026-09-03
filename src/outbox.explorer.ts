import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { OUTBOX_EVENT_METADATA } from './outbox.constants';
import type { OutboxHandler } from './interfaces/outbox-handler.interface';

@Injectable()
export class OutboxExplorer implements OnModuleInit {
  private readonly logger = new Logger(OutboxExplorer.name);
  private readonly handlers = new Map<string, OutboxHandler[]>();
  private readonly discovered = new WeakMap<object, Map<string, Set<string>>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const wrappers = this.discovery.getProviders();

    for (const wrapper of wrappers) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;

      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) continue;

      const methodNames = this.metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        const eventTypes = this.reflector.get<string[]>(
          OUTBOX_EVENT_METADATA,
          prototype[methodName],
        );
        if (!eventTypes || eventTypes.length === 0) continue;

        const handler: OutboxHandler = {
          instance: instance as Record<string, any>,
          methodName,
          eventTypes,
        };

        for (const eventType of eventTypes) {
          this.assertUniqueDiscovery(instance, methodName, eventType);
          const existing = this.handlers.get(eventType) ?? [];
          existing.push(handler);
          this.handlers.set(eventType, existing);
          this.logger.log(
            `Registered handler ${instance.constructor.name}.${methodName} for "${eventType}"`,
          );
        }
      }
    }
  }

  getHandlers(eventType: string): OutboxHandler[] {
    return this.handlers.get(eventType) ?? [];
  }

  getRegisteredEventTypes(): string[] {
    return [...this.handlers.keys()];
  }

  private assertUniqueDiscovery(
    instance: object,
    methodName: string,
    eventType: string,
  ): void {
    let methods = this.discovered.get(instance);
    if (!methods) {
      methods = new Map();
      this.discovered.set(instance, methods);
    }
    let eventTypes = methods.get(methodName);
    if (!eventTypes) {
      eventTypes = new Set();
      methods.set(methodName, eventTypes);
    }
    if (eventTypes.has(eventType)) {
      throw new Error(
        `Duplicate outbox handler discovery for ${instance.constructor.name}.${methodName} and "${eventType}"`,
      );
    }
    eventTypes.add(eventType);
  }
}
