import { Module } from '@nestjs/common';
import { OutboxModule } from '@nestarc/outbox';
import {
  ConfirmationService,
  OrderConfirmationListener,
} from './order-confirmation.listener';
import { OrderService } from './order.service';
import { PrismaModule, PrismaService } from './prisma.module';

@Module({
  imports: [
    PrismaModule,
    OutboxModule.forRoot({
      prisma: PrismaService,
      // A shorter interval keeps this one-shot demonstration quick.
      polling: { interval: 250 },
    }),
  ],
  providers: [OrderService, ConfirmationService, OrderConfirmationListener],
})
export class AppModule {}
