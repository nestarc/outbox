import { Test } from '@nestjs/testing';
import { OutboxModule } from '../src/outbox.module';
import { OutboxEmitter } from '../src/outbox.emitter';
import { OUTBOX_OPTIONS, OUTBOX_TRANSPORT } from '../src/outbox.constants';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

describe('OutboxModule', () => {
  describe('forRoot', () => {
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

    it('should throw if no provider method is given', () => {
      expect(() => {
        OutboxModule.forRootAsync({});
      }).toThrow(
        'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
      );
    });
  });
});
