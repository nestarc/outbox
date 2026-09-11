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
import {
  OutboxOperatorService,
  OutboxTenantAdminService,
} from './outbox.admin.service';
import { OutboxEmitter } from './outbox.emitter';
import { OutboxExplorer } from './outbox.explorer';
import { OutboxListener } from './outbox.listener';
import { OutboxPoller } from './outbox.poller';
import { LocalTransport } from './transports/local.transport';
import type {
  OutboxAsyncOptions,
  OutboxAsyncRuntimeOptions,
  OutboxOptions,
  OutboxOptionsFactory,
} from './interfaces/outbox-options.interface';
import type { OutboxTenantProvider } from './interfaces/outbox-tenancy.interface';
import {
  validateOutboxOptions,
  validateOutboxTenantProviderInstance,
  validateOutboxTenantProviderRegistration,
} from './outbox-invariants';
import { OutboxSchemaGuard } from './outbox.schema';
import { OutboxConfigurationError } from './errors/outbox-configuration.error';

const OUTBOX_TENANT_PROVIDER_VALIDATION = Symbol(
  'OUTBOX_TENANT_PROVIDER_VALIDATION',
);

@Module({})
export class OutboxModule {
  static forRoot(options: OutboxOptions): DynamicModule {
    this.validateRegistrationOptions(options);
    const prismaRef = options.prisma;
    const isPrismaClass = typeof prismaRef === 'function';

    const optionsProvider: Provider = isPrismaClass
      ? {
          provide: OUTBOX_OPTIONS,
          inject: [prismaRef],
          useFactory: (prismaInstance: any): OutboxOptions =>
            validateOutboxOptions({
              ...options,
              prisma: prismaInstance,
            }),
        }
      : {
          provide: OUTBOX_OPTIONS,
          useFactory: (): OutboxOptions => validateOutboxOptions(options),
        };

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: options.transport ?? LocalTransport,
    };
    const tenantProvider = this.createTenantProvider(options.tenancy?.provider);

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ScheduleModule.forRoot()],
      providers: [
        optionsProvider,
        transportProvider,
        ...tenantProvider,
        OutboxOperatorService,
        OutboxTenantAdminService,
        OutboxSchemaGuard,
        OutboxEmitter,
        OutboxPoller,
        OutboxListener,
        OutboxExplorer,
      ],
      exports: [
        OutboxOperatorService,
        OutboxTenantAdminService,
        OutboxEmitter,
        OUTBOX_OPTIONS,
        OUTBOX_TRANSPORT,
        OUTBOX_TENANT_PROVIDER,
      ],
    };
  }

  static forRootAsync(options: OutboxAsyncOptions): DynamicModule {
    this.validateRegistrationOptions(options);
    const asyncProviders = this.createAsyncProviders(options);

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: options.transport ?? LocalTransport,
    };
    const tenantProvider = this.createTenantProvider(
      options.tenantProvider,
      'tenantProvider',
    );

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
        ...tenantProvider,
        OutboxOperatorService,
        OutboxTenantAdminService,
        OutboxSchemaGuard,
        OutboxEmitter,
        OutboxPoller,
        OutboxListener,
        OutboxExplorer,
      ],
      exports: [
        OutboxOperatorService,
        OutboxTenantAdminService,
        OutboxEmitter,
        OUTBOX_OPTIONS,
        OUTBOX_TRANSPORT,
        OUTBOX_TENANT_PROVIDER,
      ],
    };
  }

  private static createTenantProvider(
    provider?: Type<OutboxTenantProvider> | OutboxTenantProvider,
    option = 'tenancy.provider',
  ): Provider[] {
    validateOutboxTenantProviderRegistration(provider, option);
    if (provider === undefined) {
      return [
        {
          provide: OUTBOX_TENANT_PROVIDER,
          useValue: null,
        },
      ];
    }

    if (typeof provider === 'function') {
      return [
        { provide: OUTBOX_TENANT_PROVIDER, useClass: provider },
        {
          provide: OUTBOX_TENANT_PROVIDER_VALIDATION,
          inject: [OUTBOX_TENANT_PROVIDER],
          useFactory: (instance: OutboxTenantProvider): boolean => {
            validateOutboxTenantProviderInstance(instance, option);
            return true;
          },
        },
      ];
    }

    return [
      {
        provide: OUTBOX_TENANT_PROVIDER,
        useValue: provider,
      },
    ];
  }

  private static createAsyncProviders(options: OutboxAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: async (...args: any[]): Promise<OutboxOptions> =>
            this.validateAsyncRuntimeOptions(
              await options.useFactory!(...args),
            ),
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: async (
            factory: OutboxOptionsFactory,
          ): Promise<OutboxOptions> =>
            this.validateAsyncRuntimeOptions(
              await factory.createOutboxOptions(),
            ),
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
          useFactory: async (
            factory: OutboxOptionsFactory,
          ): Promise<OutboxOptions> =>
            this.validateAsyncRuntimeOptions(
              await factory.createOutboxOptions(),
            ),
          inject: [useClass],
        },
      ];
    }

    throw new Error(
      'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
    );
  }

  private static validateAsyncRuntimeOptions(
    runtimeOptions: OutboxAsyncRuntimeOptions,
  ): OutboxOptions {
    const candidate = runtimeOptions as OutboxOptions;
    if (
      candidate &&
      (Object.prototype.hasOwnProperty.call(candidate, 'transport') ||
        Object.prototype.hasOwnProperty.call(candidate, 'isGlobal') ||
        (candidate.tenancy &&
          Object.prototype.hasOwnProperty.call(candidate.tenancy, 'provider')))
    ) {
      throw new Error(
        'OutboxModule.forRootAsync requires transport, tenantProvider, and isGlobal to be registered as top-level async options',
      );
    }

    return validateOutboxOptions(candidate);
  }

  private static validateRegistrationOptions(
    options: OutboxOptions | OutboxAsyncOptions,
  ): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new OutboxConfigurationError('options', 'must be an object');
    }
    if (
      options.isGlobal !== undefined &&
      typeof options.isGlobal !== 'boolean'
    ) {
      throw new OutboxConfigurationError('isGlobal', 'must be a boolean');
    }
  }
}
