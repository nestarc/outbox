import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import {
  OUTBOX_OPTIONS,
  OUTBOX_TENANT_PROVIDER,
  OUTBOX_TRANSPORT,
} from './outbox.constants';
import { OutboxAdminService } from './outbox.admin.service';
import { OutboxEmitter } from './outbox.emitter';
import { OutboxExplorer } from './outbox.explorer';
import { OutboxListener } from './outbox.listener';
import { OutboxPoller } from './outbox.poller';
import { LocalTransport } from './transports/local.transport';
import type {
  OutboxAsyncOptions,
  OutboxOptions,
  OutboxOptionsFactory,
} from './interfaces/outbox-options.interface';
import type { OutboxTenantProvider } from './interfaces/outbox-tenancy.interface';

@Module({})
export class OutboxModule {
  static forRoot(options: OutboxOptions): DynamicModule {
    const prismaRef = options.prisma;
    const isPrismaClass = typeof prismaRef === 'function';

    const optionsProvider: Provider = isPrismaClass
      ? {
          provide: OUTBOX_OPTIONS,
          inject: [prismaRef],
          useFactory: (prismaInstance: any): OutboxOptions => ({
            ...options,
            prisma: prismaInstance,
          }),
        }
      : {
          provide: OUTBOX_OPTIONS,
          useValue: options,
        };

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: options.transport ?? LocalTransport,
    };
    const tenantProvider = this.createTenantProvider(
      options.tenancy?.provider,
    );

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ScheduleModule.forRoot()],
      providers: [
        optionsProvider,
        transportProvider,
        tenantProvider,
        OutboxAdminService,
        OutboxEmitter,
        OutboxPoller,
        OutboxListener,
        OutboxExplorer,
      ],
      exports: [
        OutboxAdminService,
        OutboxEmitter,
        OUTBOX_OPTIONS,
        OUTBOX_TRANSPORT,
        OUTBOX_TENANT_PROVIDER,
      ],
    };
  }

  static forRootAsync(options: OutboxAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: options.transport ?? LocalTransport,
    };
    const tenantProvider = this.createAsyncTenantProvider();

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [
        DiscoveryModule,
        ScheduleModule.forRoot(),
        ...(options.imports ?? []),
      ],
      providers: [
        ...asyncProviders,
        transportProvider,
        tenantProvider,
        OutboxAdminService,
        OutboxEmitter,
        OutboxPoller,
        OutboxListener,
        OutboxExplorer,
      ],
      exports: [
        OutboxAdminService,
        OutboxEmitter,
        OUTBOX_OPTIONS,
        OUTBOX_TRANSPORT,
        OUTBOX_TENANT_PROVIDER,
      ],
    };
  }

  private static createTenantProvider(
    provider?: Type<OutboxTenantProvider> | OutboxTenantProvider,
  ): Provider {
    if (!provider) {
      return {
        provide: OUTBOX_TENANT_PROVIDER,
        useValue: null,
      };
    }

    if (typeof provider === 'function') {
      return {
        provide: OUTBOX_TENANT_PROVIDER,
        useClass: provider,
      };
    }

    return {
      provide: OUTBOX_TENANT_PROVIDER,
      useValue: provider,
    };
  }

  private static createAsyncTenantProvider(): Provider {
    return {
      provide: OUTBOX_TENANT_PROVIDER,
      inject: [OUTBOX_OPTIONS],
      useFactory: (options: OutboxOptions): OutboxTenantProvider | null => {
        const provider = options.tenancy?.provider;
        if (!provider) return null;
        if (typeof provider === 'function') {
          return new provider();
        }
        return provider;
      },
    };
  }

  private static createAsyncProviders(
    options: OutboxAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: (factory: OutboxOptionsFactory) =>
            factory.createOutboxOptions(),
          inject: [options.useExisting],
        },
      ];
    }

    if (options.useClass) {
      const useClass: Type<OutboxOptionsFactory> = options.useClass;
      return [
        { provide: useClass, useClass },
        {
          provide: OUTBOX_OPTIONS,
          useFactory: (factory: OutboxOptionsFactory) =>
            factory.createOutboxOptions(),
          inject: [useClass],
        },
      ];
    }

    throw new Error(
      'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
    );
  }
}
