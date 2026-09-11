import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxModule } from '../src/outbox.module';
import { OutboxEmitter } from '../src/outbox.emitter';
import {
  OutboxAdminService,
  OutboxOperatorService,
  OutboxTenantAdminService,
} from '../src/outbox.admin.service';
import {
  OUTBOX_OPTIONS,
  OUTBOX_TENANT_PROVIDER,
  OUTBOX_TRANSPORT,
} from '../src/outbox.constants';
import type {
  OutboxAsyncRuntimeOptions,
  OutboxOptions,
  OutboxOptionsFactory,
} from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';
import type { OutboxTenantProvider } from '../src/interfaces/outbox-tenancy.interface';
import { OutboxConfigurationError } from '../src/errors/outbox-configuration.error';

const schemaInventory = {
  tableExists: true,
  columns: [
    'id',
    'event_type',
    'payload',
    'status',
    'created_at',
    'updated_at',
    'processed_at',
    'next_attempt_at',
    'retry_count',
    'max_retries',
    'last_error',
    'tenant_id',
    'aggregate_type',
    'aggregate_id',
    'partition_key',
    'idempotency_key',
    'correlation_id',
    'causation_id',
    'headers',
    'occurred_at',
    'claim_token',
    'lease_expires_at',
  ],
  indexes: [
    'idx_outbox_pending',
    'idx_outbox_processing',
    'idx_outbox_processing_claim_token',
    'idx_outbox_processing_lease_expiry',
    'idx_outbox_failed',
    'idx_outbox_admin_created',
    'idx_outbox_tenant_admin',
    'idx_outbox_tenant_status_admin',
    'idx_outbox_tenant_processing',
    'idx_outbox_sent_retention',
    'idx_outbox_tenant_sent_retention',
  ],
  constraints: [
    'chk_status',
    'chk_retry_count_nonnegative',
    'chk_max_retries_positive',
    'chk_payload_object',
    'chk_headers_object',
    'chk_nonprocessing_claim_clear',
  ],
};

const mockPrisma = {
  $queryRaw: jest.fn().mockResolvedValue([schemaInventory]),
  $executeRaw: jest.fn(),
};

@Injectable()
class MockPrismaService {
  $queryRaw = jest.fn();
  $executeRaw = jest.fn();
}

describe('OutboxModule', () => {
  describe('runtime option validation', () => {
    it.each(['forRoot', 'forRootAsync'] as const)(
      'rejects an invalid tenant policy through %s before emit is called',
      async (registration) => {
        const options = {
          prisma: mockPrisma,
          tenancy: { policy: 'requird' },
        } as unknown as OutboxOptions;
        const outbox =
          registration === 'forRoot'
            ? OutboxModule.forRoot(options)
            : OutboxModule.forRootAsync({
                useFactory: () => options as OutboxAsyncRuntimeOptions,
              });

        await expect(
          Test.createTestingModule({ imports: [outbox] }).compile(),
        ).rejects.toMatchObject({
          name: 'OutboxConfigurationError',
          code: 'OUTBOX_INVALID_CONFIGURATION',
          option: 'tenancy.policy',
        });
      },
    );

    it.each(['forRoot', 'forRootAsync'] as const)(
      'validates tenant class fields after Nest constructs them through %s',
      async (registration) => {
        @Injectable()
        class InvalidTenantProvider {
          getTenantId = 'tenant-a';
        }

        const provider =
          InvalidTenantProvider as unknown as new () => OutboxTenantProvider;
        const outbox =
          registration === 'forRoot'
            ? OutboxModule.forRoot({
                prisma: mockPrisma,
                tenancy: { provider },
              })
            : OutboxModule.forRootAsync({
                useFactory: () => ({ prisma: mockPrisma }),
                tenantProvider: provider,
              });
        await expect(
          Test.createTestingModule({ imports: [outbox] }).compile(),
        ).rejects.toMatchObject({
          name: 'OutboxConfigurationError',
          option:
            registration === 'forRoot'
              ? 'tenancy.provider.getTenantId'
              : 'tenantProvider.getTenantId',
        });
      },
    );

    it('rejects invalid async module scope before registering providers', () => {
      expect(() =>
        OutboxModule.forRootAsync({
          useFactory: () => ({ prisma: mockPrisma }),
          isGlobal: 'yes' as unknown as boolean,
        }),
      ).toThrow(OutboxConfigurationError);
    });

    it('reports an invalid async factory result as a configuration error', async () => {
      await expect(
        Test.createTestingModule({
          imports: [
            OutboxModule.forRootAsync({
              useFactory: () => null as unknown as OutboxAsyncRuntimeOptions,
            }),
          ],
        }).compile(),
      ).rejects.toMatchObject({
        name: 'OutboxConfigurationError',
        option: 'options',
      });
    });

    it.each([
      ['negative stuckThreshold', { stuckThreshold: -1 }],
      ['zero batch size', { polling: { enabled: true, batchSize: 0 } }],
      ['NaN polling interval', { polling: { enabled: true, interval: NaN } }],
      ['zero max retries', { retry: { maxRetries: 0 } }],
      ['non-object retry options', { retry: 'invalid' }],
      [
        'negative reconnect delay',
        {
          wakeup: { enabled: true, reconnectDelay: -1 },
        },
      ],
    ])('rejects %s during module compilation', async (_label, invalid) => {
      await expect(
        Test.createTestingModule({
          imports: [
            OutboxModule.forRoot({
              prisma: mockPrisma,
              polling: { enabled: false },
              ...invalid,
            } as unknown as OutboxOptions),
          ],
        }).compile(),
      ).rejects.toThrow(/Outbox/);
    });

    it('validates options returned by an async factory', async () => {
      await expect(
        Test.createTestingModule({
          imports: [
            OutboxModule.forRootAsync({
              useFactory: () => ({
                prisma: mockPrisma,
                polling: { enabled: true, interval: Number.POSITIVE_INFINITY },
              }),
            }),
          ],
        }).compile(),
      ).rejects.toThrow(/Outbox/);
    });

    it('rejects an unknown delivery mode at runtime', async () => {
      await expect(
        Test.createTestingModule({
          imports: [
            OutboxModule.forRoot({
              prisma: mockPrisma,
              delivery: { mode: 'unknown' as 'local' },
            }),
          ],
        }).compile(),
      ).rejects.toThrow(/delivery\.mode/);
    });

    it('rejects disabled periodic polling during module initialization', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
            wakeup: { enabled: false },
          }),
        ],
      }).compile();

      await expect(module.init()).rejects.toMatchObject({
        code: 'OUTBOX_INVALID_CONFIGURATION',
        option: 'polling.enabled',
      });
    });

    it('rejects a publisher mode backed by the default local transport', async () => {
      await expect(
        Test.createTestingModule({
          imports: [
            OutboxModule.forRoot({
              prisma: mockPrisma,
              polling: { enabled: false },
              wakeup: { enabled: true, clientFactory: () => null },
              delivery: { mode: 'publisher' },
            }),
          ],
        }).compile(),
      ).rejects.toThrow(/publisher/);
    });
  });

  describe('forRoot', () => {
    it('should resolve prisma class reference via DI', async () => {
      @Global()
      @Module({
        providers: [MockPrismaService],
        exports: [MockPrismaService],
      })
      class PrismaModule {}

      const module = await Test.createTestingModule({
        imports: [
          PrismaModule,
          OutboxModule.forRoot({
            prisma: MockPrismaService,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      // prisma should be the resolved instance, not the class
      expect(options.prisma).toBeInstanceOf(MockPrismaService);
    });

    it('should provide OutboxEmitter', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const emitter = module.get(OutboxEmitter);
      expect(emitter).toBeInstanceOf(OutboxEmitter);
    });

    it('should provide operator and tenant-safe admin boundaries', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const operator = module.get(OutboxOperatorService);
      expect(operator).toBeInstanceOf(OutboxOperatorService);
      expect(module.get(OutboxAdminService)).toBe(operator);
      expect(module.get(OutboxTenantAdminService)).toBeInstanceOf(
        OutboxTenantAdminService,
      );
    });

    it('should provide OUTBOX_OPTIONS', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
            retry: { maxRetries: 10 },
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(10);
    });

    it('should provide OUTBOX_TRANSPORT', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const transport = module.get<OutboxTransport>(OUTBOX_TRANSPORT);
      expect(transport).toBeDefined();
      expect(typeof transport.dispatch).toBe('function');
    });

    it('should use custom transport when provided', async () => {
      @Injectable()
      class CustomTransport implements OutboxTransport {
        async dispatch(): Promise<void> {}
      }

      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
            transport: CustomTransport,
          }),
        ],
      }).compile();

      const transport = module.get<OutboxTransport>(OUTBOX_TRANSPORT);
      expect(transport).toBeInstanceOf(CustomTransport);
    });
  });

  describe('forRootAsync', () => {
    it('should support useFactory', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            useFactory: () => ({
              prisma: mockPrisma,
              polling: { enabled: false },
              retry: { maxRetries: 7 },
            }),
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(7);
    });

    it('should support useClass', async () => {
      @Injectable()
      class OutboxConfigService implements OutboxOptionsFactory {
        createOutboxOptions(): OutboxAsyncRuntimeOptions {
          return {
            prisma: mockPrisma,
            polling: { enabled: false },
            retry: { maxRetries: 12 },
          };
        }
      }

      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            useClass: OutboxConfigService,
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(12);
    });

    it('should support useExisting', async () => {
      @Injectable()
      class ExistingConfigService implements OutboxOptionsFactory {
        createOutboxOptions(): OutboxAsyncRuntimeOptions {
          return {
            prisma: mockPrisma,
            polling: { enabled: false },
            retry: { maxRetries: 15 },
          };
        }
      }

      @Module({
        providers: [ExistingConfigService],
        exports: [ExistingConfigService],
      })
      class ConfigModule {}

      const module = await Test.createTestingModule({
        imports: [
          ConfigModule,
          OutboxModule.forRootAsync({
            imports: [ConfigModule],
            useExisting: ExistingConfigService,
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(15);
    });

    it('lets Nest construct tenant providers and transports with imported dependencies', async () => {
      const SUPPORT_TOKEN = Symbol('ASYNC_REGISTRATION_SUPPORT');
      const support = { tenantId: 'tenant-from-di' };

      @Module({
        providers: [{ provide: SUPPORT_TOKEN, useValue: support }],
        exports: [SUPPORT_TOKEN],
      })
      class SupportModule {}

      @Injectable()
      class InjectedTenantProvider implements OutboxTenantProvider {
        constructor(
          @Inject(SUPPORT_TOKEN)
          readonly dependency: typeof support,
        ) {}

        getTenantId(): string {
          return this.dependency.tenantId;
        }
      }

      @Injectable()
      class InjectedTransport implements OutboxTransport {
        constructor(
          @Inject(SUPPORT_TOKEN)
          readonly dependency: typeof support,
        ) {}

        async dispatch(): Promise<void> {}
      }

      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            imports: [SupportModule],
            useFactory: () => ({
              prisma: mockPrisma,
              polling: { enabled: false },
            }),
            tenantProvider: InjectedTenantProvider,
            transport: InjectedTransport,
          }),
        ],
      }).compile();

      const tenantProvider = module.get<InjectedTenantProvider>(
        OUTBOX_TENANT_PROVIDER,
      );
      const transport = module.get<InjectedTransport>(OUTBOX_TRANSPORT);
      expect(tenantProvider).toBeInstanceOf(InjectedTenantProvider);
      expect(tenantProvider.dependency).toBe(support);
      expect(await tenantProvider.getTenantId()).toBe('tenant-from-di');
      expect(transport).toBeInstanceOf(InjectedTransport);
      expect(transport.dependency).toBe(support);
    });

    it('preserves an existing tenant provider instance and its methods', async () => {
      const provider = { getTenantId: jest.fn(() => 'tenant-instance') };
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            useFactory: () => ({ prisma: mockPrisma }),
            tenantProvider: provider,
          }),
        ],
      }).compile();

      expect(module.get(OUTBOX_TENANT_PROVIDER)).toBe(provider);
      expect(provider.getTenantId).not.toHaveBeenCalled();
    });

    it('supports tenant class fields with dependencies on resolved outbox options', async () => {
      @Injectable()
      class OptionsTenantProvider implements OutboxTenantProvider {
        constructor(@Inject(OUTBOX_OPTIONS) readonly options: OutboxOptions) {}
        getTenantId = () => 'tenant-from-class-field';
      }

      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            useFactory: () => ({
              prisma: mockPrisma,
              tenancy: { policy: 'required' },
            }),
            tenantProvider: OptionsTenantProvider,
          }),
        ],
      }).compile();

      const provider = module.get<OptionsTenantProvider>(
        OUTBOX_TENANT_PROVIDER,
      );
      expect(provider).toBeInstanceOf(OptionsTenantProvider);
      expect(provider.options).toBe(module.get(OUTBOX_OPTIONS));
      expect(provider.getTenantId()).toBe('tenant-from-class-field');
    });

    it.each([
      ['transport', { transport: class UnsupportedTransport {} }],
      ['isGlobal', { isGlobal: false }],
      [
        'tenancy.provider',
        { tenancy: { provider: class UnsupportedTenantProvider {} } },
      ],
    ])(
      'rejects factory-owned async registration option %s',
      async (_key, extra) => {
        await expect(
          Test.createTestingModule({
            imports: [
              OutboxModule.forRootAsync({
                useFactory: () =>
                  ({
                    prisma: mockPrisma,
                    polling: { enabled: false },
                    ...extra,
                  }) as any,
              }),
            ],
          }).compile(),
        ).rejects.toThrow(/top-level async options/);
      },
    );

    it('should throw if no provider method is given', () => {
      expect(() => {
        OutboxModule.forRootAsync({});
      }).toThrow(
        'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
      );
    });
  });
});
