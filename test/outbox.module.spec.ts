import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxModule } from '../src/outbox.module';
import { OutboxEmitter } from '../src/outbox.emitter';
import { OUTBOX_OPTIONS, OUTBOX_TRANSPORT } from '../src/outbox.constants';
import type { OutboxOptions, OutboxOptionsFactory } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

@Injectable()
class MockPrismaService {
  $queryRaw = jest.fn();
  $executeRaw = jest.fn();
}

describe('OutboxModule', () => {
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
        createOutboxOptions(): OutboxOptions {
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
        createOutboxOptions(): OutboxOptions {
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

    it('should throw if no provider method is given', () => {
      expect(() => {
        OutboxModule.forRootAsync({});
      }).toThrow(
        'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
      );
    });
  });
});
