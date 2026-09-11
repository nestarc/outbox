// Application-owned services used by the README fragments. Only the broker
// and email side effects are doubles; Prisma and Nest run without overrides.
import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContext } from './tenant-provider';
export {
  TenantContext,
  RequestTenantProvider,
  TenantContextProvider,
} from './tenant-provider';

@Injectable()
export class PrismaService extends PrismaClient {}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}

export interface CreateOrderDto {
  total: number;
  tenantId: string;
  requestId: string;
}

@Injectable()
export class EmailService {
  // This double verifies forwarding. A real provider owns durable deduplication.
  readonly confirmations: Array<{ orderId: string; idempotencyKey: string }> =
    [];
  async sendOrderConfirmation(
    orderId: string,
    options: { idempotencyKey: string },
  ): Promise<void> {
    this.confirmations.push({
      orderId,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

@Injectable()
export class ConfigService {
  get(key: string): number {
    if (key !== 'OUTBOX_POLL_INTERVAL') throw new Error(`Unknown key: ${key}`);
    return 25;
  }
}

@Module({ providers: [ConfigService], exports: [ConfigService] })
export class ConfigModule {}

@Module({ providers: [TenantContext], exports: [TenantContext] })
export class TenantContextModule {}

interface BrokerMessage {
  topic: string;
  messages: Array<{
    key: string;
    value: string;
    headers: Readonly<Record<string, string>>;
  }>;
}

@Injectable()
export class KafkaProducer {
  readonly sent: BrokerMessage[] = [];
  async send(message: BrokerMessage): Promise<void> {
    this.sent.push(message);
  }
}

@Module({ providers: [KafkaProducer], exports: [KafkaProducer] })
export class KafkaModule {}
