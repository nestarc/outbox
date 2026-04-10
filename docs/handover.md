# @nestarc/outbox — 핸드오버 문서

> **작성일**: 2026-04-10
> **목적**: 다음 세션(Claude Code 등)에서 바로 구현을 시작할 수 있도록 설계 결정사항과 컨텍스트를 정리
> **선행 패키지**: `@nestarc/tenancy` (published), `@nestarc/idempotency` v0.1.3 (published)
> **GitHub**: `nestarc` org 아래 `outbox` 레포 생성 예정

---

## 1. 해결하는 문제 (Dual Write)

마이크로서비스에서 **DB 쓰기와 메시지 발행을 동시에 해야 할 때**, 두 시스템은 하나의 트랜잭션으로 묶을 수 없다.

```
❌ 실패 시나리오
OrderService.createOrder()
  ├─ DB에 주문 INSERT → 성공
  └─ Kafka에 'order.created' 발행 → 네트워크 실패
  → 주문은 DB에 있지만, 배송/알림 서비스는 모름
```

**Outbox 패턴**: 이벤트를 같은 DB에 먼저 저장하고(하나의 트랜잭션), 별도 프로세스가 읽어서 메시지 브로커에 전달.

```
✅ Outbox 패턴
OrderService.createOrder()
  └─ 하나의 DB 트랜잭션:
       ├─ orders 테이블에 INSERT
       └─ outbox_events 테이블에 INSERT
              ↓ (비동기)
       [Poller / LISTEN/NOTIFY] → Kafka / RabbitMQ / EventEmitter
```

---

## 2. 경쟁 분석 (2026-04 기준)

### 2.1 `@fullstackhouse/nestjs-outbox` — 최강 경쟁자

- **버전**: v4.1.2 (2025-12 생성, 12 버전 릴리즈)
- **ORM**: TypeORM 드라이버 + MikroORM 드라이버 (별도 패키지)
- **기능**: Polling, PG LISTEN/NOTIFY (MikroORM만), OTel 트레이싱 미들웨어, Graceful shutdown, `@OnEvent()` 데코레이터, `TransactionalEventEmitter`, 에러 필터(`isOutboxContext`), 드라이버 확장 인터페이스
- **Prisma**: ❌ 미지원
- **평가**: 가장 성숙하고 활발. 모노레포 구조로 잘 설계됨. 하지만 Prisma 드라이버가 없고, LISTEN/NOTIFY도 MikroORM 전용.

### 2.2 `@nestixis/nestjs-inbox-outbox`

- **ORM**: TypeORM 전용
- **기능**: Outbox + Inbox 통합, `@Listener` 데코레이터, 즉시 전달 + 실패 시 폴링 재시도, pessimistic locking
- **Prisma**: ❌ 미지원
- **평가**: 블로그 홍보 활발하나 npm registry 상태 불명확. Inbox 패턴 통합이 차별점.

### 2.3 `@naviedu/nestjs-outbox-inbox`

- **ORM**: TypeORM(MySQL) + MongoDB
- **기능**: RabbitMQ / Kafka 지원
- **peer deps**: 15개 (과잉)
- **평가**: 1개 버전만 릴리즈 후 방치. 고려 대상 아님.

### 2.4 `@mobile-reality/nestjs-outbox`

- **버전**: 0.0.1-alpha.1 (3년 전)
- **평가**: 사실상 죽은 프로젝트.

### 2.5 경쟁 종합표

| 기능 | fullstackhouse | nestixis | naviedu | **@nestarc (목표)** |
|------|:-:|:-:|:-:|:-:|
| **Prisma** | ❌ | ❌ | ❌ | **✅** |
| TypeORM | ✅ | ✅ | ✅ | ❌ (비목표) |
| MikroORM | ✅ | ❌ | ❌ | ❌ (비목표) |
| PG LISTEN/NOTIFY | MikroORM만 | ❌ | ❌ | ✅ (v0.2) |
| Polling | ✅ | ✅ | ✅ | ✅ |
| Inbox 패턴 | ❌ | ✅ | ✅ | v0.2 |
| OTel 트레이싱 | ✅ | ❌ | ❌ | v0.2 |
| Graceful shutdown | ✅ | ✅ | ❌ | ✅ |
| @nestarc/tenancy 연동 | ❌ | ❌ | ❌ | ✅ (v0.2) |
| 드라이버 확장성 | ✅ | ✅ | ❌ | ✅ |
| 활발한 유지보수 | ✅ | ❓ | ❌ | - |

### 2.6 차별화 전략

**"Prisma-native transactional outbox for NestJS"** — 이 한 문장이 포지셔닝.

1. **Prisma `$transaction` 네이티브 통합** — `prisma.$transaction()` 안에서 비즈니스 로직 + outbox 이벤트를 원자적으로 저장
2. **PostgreSQL LISTEN/NOTIFY + Prisma `$queryRaw`** — fullstackhouse는 MikroORM에서만 지원
3. **@nestarc/tenancy 연동** — 테넌트 컨텍스트가 outbox 이벤트에 자동 태깅
4. **@nestarc/idempotency 조합** — 소비자 측 중복 처리 방지

---

## 3. 핵심 개념 정리

### 3.1 Outbox 테이블 구조

```sql
CREATE TABLE outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    VARCHAR(255) NOT NULL,           -- 'order.created'
  payload       JSONB NOT NULL,                  -- 이벤트 데이터
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | PROCESSING | SENT | FAILED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  retry_count   INT NOT NULL DEFAULT 0,
  max_retries   INT NOT NULL DEFAULT 5,
  last_error    TEXT,
  tenant_id     VARCHAR(255)                     -- @nestarc/tenancy 연동용 (nullable)
);

CREATE INDEX idx_outbox_status_created ON outbox_events (status, created_at)
  WHERE status = 'PENDING';
```

### 3.2 Prisma 스키마

```prisma
model OutboxEvent {
  id           String   @id @default(uuid()) @db.Uuid
  eventType    String   @map("event_type") @db.VarChar(255)
  payload      Json
  status       String   @default("PENDING") @map("status") @db.VarChar(20)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  processedAt  DateTime? @map("processed_at") @db.Timestamptz
  retryCount   Int      @default(0) @map("retry_count")
  maxRetries   Int      @default(5) @map("max_retries")
  lastError    String?  @map("last_error") @db.Text
  tenantId     String?  @map("tenant_id") @db.VarChar(255)

  @@index([status, createdAt], name: "idx_outbox_status_created")
  @@map("outbox_events")
}
```

### 3.3 이벤트 전달 방식

**Polling (MVP)**: `@nestjs/schedule`의 `@Interval()`로 주기적 조회. 구현 간단, 지연은 폴링 간격만큼.

**PG LISTEN/NOTIFY (v0.2)**: outbox_events에 trigger 걸어서 INSERT 시 NOTIFY. Prisma의 `$queryRawUnsafe('LISTEN outbox_channel')` + pg 드라이버의 notification 이벤트로 수신. 실시간에 가까운 지연.

---

## 4. 설계 — API 인터페이스

### 4.1 모듈 등록

```typescript
// app.module.ts
import { OutboxModule } from '@nestarc/outbox';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    OutboxModule.forRoot({
      prisma: PrismaService,               // PrismaService 클래스 참조
      polling: {
        enabled: true,
        interval: 5000,                     // 5초마다 폴링
        batchSize: 100,                     // 한 번에 가져올 이벤트 수
      },
      retry: {
        maxRetries: 5,
        backoff: 'exponential',             // 'fixed' | 'exponential'
        initialDelay: 1000,                 // 1초
      },
      events: [OrderCreatedEvent, OrderPaidEvent],  // 등록할 이벤트 클래스
    }),
  ],
})
export class AppModule {}
```

### 4.2 Async 등록

```typescript
OutboxModule.forRootAsync({
  imports: [ConfigModule, PrismaModule],
  inject: [ConfigService, PrismaService],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    prisma,
    polling: {
      enabled: true,
      interval: config.get('OUTBOX_POLL_INTERVAL', 5000),
      batchSize: config.get('OUTBOX_BATCH_SIZE', 100),
    },
    retry: {
      maxRetries: config.get('OUTBOX_MAX_RETRIES', 5),
    },
  }),
}),
```

### 4.3 이벤트 정의

```typescript
import { OutboxEvent } from '@nestarc/outbox';

export class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly customerId: string,
    public readonly total: number,
  ) {
    super();
  }
}
```

### 4.4 이벤트 발행 (트랜잭션 내)

```typescript
import { OutboxEmitter } from '@nestarc/outbox';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEmitter,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. 비즈니스 로직
      const order = await tx.order.create({ data: dto });

      // 2. 같은 트랜잭션 안에서 outbox 이벤트 저장
      await this.outbox.emit(
        tx,  // 트랜잭션 클라이언트 전달
        new OrderCreatedEvent(order.id, dto.customerId, dto.total),
      );

      return order;
    });
  }
}
```

**핵심**: `outbox.emit(tx, event)`는 tx(Prisma Transaction Client)를 받아서 같은 트랜잭션 안에서 outbox_events 테이블에 INSERT. DB 트랜잭션이 롤백되면 이벤트도 함께 롤백.

### 4.5 이벤트 구독 (리스너)

```typescript
import { OnOutboxEvent } from '@nestarc/outbox';

@Injectable()
export class OrderNotificationListener {
  constructor(private readonly emailService: EmailService) {}

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(event: OrderCreatedEvent) {
    await this.emailService.sendOrderConfirmation(event.orderId);
    // 이 메서드가 성공하면 이벤트 status → SENT
    // throw하면 retry 큐에 들어감
  }
}
```

### 4.6 플로우 다이어그램

```
[OrderService.createOrder()]
    │
    │  prisma.$transaction
    ├──→ orders INSERT
    └──→ outbox_events INSERT (status=PENDING)
              │
              │  (비동기)
              ▼
    [OutboxPoller] ── @Interval(5000) ──
        │
        ├─ 1. SELECT * FROM outbox_events WHERE status='PENDING' ORDER BY created_at LIMIT 100
        │
        ├─ 2. 각 이벤트에 대해:
        │     ├─ status → PROCESSING (optimistic lock)
        │     ├─ 등록된 @OnOutboxEvent 리스너 실행
        │     ├─ 성공 → status → SENT, processed_at = now()
        │     └─ 실패 → retry_count++, last_error 저장
        │           ├─ retry_count < maxRetries → status → PENDING (다음 폴링에서 재시도)
        │           └─ retry_count >= maxRetries → status → FAILED
        │
        └─ 3. Graceful shutdown: 진행 중 이벤트 완료 후 종료
```

---

## 5. 핵심 인터페이스

### 5.1 OutboxEvent 기반 클래스

```typescript
export abstract class OutboxEvent {
  abstract readonly eventType: string;

  /**
   * JSON 직렬화 가능한 payload 반환.
   * 기본 구현은 클래스의 모든 열거 가능한 속성을 반환.
   */
  toPayload(): Record<string, unknown> {
    const { eventType, ...rest } = this;
    return rest;
  }
}
```

### 5.2 OutboxEmitter

```typescript
export interface OutboxEmitter {
  /**
   * Prisma 트랜잭션 클라이언트 안에서 outbox 이벤트를 원자적으로 저장.
   * @param tx - Prisma Interactive Transaction Client
   * @param event - OutboxEvent 인스턴스
   */
  emit(tx: PrismaTransactionClient, event: OutboxEvent): Promise<void>;

  /**
   * 여러 이벤트를 한 번에 저장.
   */
  emitMany(tx: PrismaTransactionClient, events: OutboxEvent[]): Promise<void>;
}
```

### 5.3 OutboxProcessor (내부)

```typescript
interface OutboxProcessor {
  /**
   * PENDING 이벤트를 배치로 가져와서 리스너에 전달.
   */
  poll(): Promise<void>;

  /**
   * Graceful shutdown.
   */
  shutdown(): Promise<void>;
}
```

---

## 6. Prisma 트랜잭션 통합 — 설계 포인트

### 6.1 Interactive Transaction

Prisma의 Interactive Transaction은 콜백 안에서 `tx` 객체를 사용:

```typescript
await prisma.$transaction(async (tx) => {
  await tx.order.create(...);
  await tx.outboxEvent.create(...);  // 같은 트랜잭션
});
```

`OutboxEmitter.emit(tx, event)` 가 `tx.outboxEvent.create()`를 호출하는 구조.

### 6.2 타입 문제

Prisma의 트랜잭션 클라이언트 타입은 `Prisma.TransactionClient`인데, 이걸 사용자의 Prisma 스키마에 `OutboxEvent` 모델이 있어야만 `tx.outboxEvent`에 접근 가능.

**두 가지 접근법:**

**A) 사용자가 Prisma 스키마에 OutboxEvent 모델을 추가 (추천)**

```prisma
// 사용자의 schema.prisma에 추가
model OutboxEvent {
  // ... (패키지가 스키마 snippet 제공)
}
```

**B) raw query 사용**

```typescript
await tx.$executeRaw`
  INSERT INTO outbox_events (event_type, payload, status)
  VALUES (${event.eventType}, ${JSON.stringify(event.toPayload())}::jsonb, 'PENDING')
`;
```

**MVP에서는 B(raw query) 방식 추천** — 사용자의 Prisma 스키마에 모델 추가를 강제하지 않아도 되고, 마이그레이션 SQL만 제공하면 됨. v0.2에서 Prisma Client Extensions를 활용한 A 방식도 지원.

### 6.3 Poller의 Prisma 사용

Poller는 트랜잭션 바깥에서 동작. 일반 PrismaService를 주입받아서 사용:

```typescript
// Poller 내부
const events = await this.prisma.$queryRaw<OutboxRecord[]>`
  UPDATE outbox_events
  SET status = 'PROCESSING'
  WHERE id IN (
    SELECT id FROM outbox_events
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *
`;
```

`FOR UPDATE SKIP LOCKED`로 다중 인스턴스에서도 안전하게 폴링.

---

## 7. MVP 스코프 (v0.1.0)

### 포함
- [x] `OutboxModule.forRoot()` / `forRootAsync()`
- [x] `OutboxEvent` 추상 기반 클래스
- [x] `OutboxEmitter` — `emit(tx, event)` / `emitMany(tx, events)`
- [x] `@OnOutboxEvent()` 리스너 데코레이터
- [x] Polling 기반 이벤트 전달 (`@nestjs/schedule`)
- [x] Prisma raw query로 outbox 테이블 연동 (스키마 독립)
- [x] `FOR UPDATE SKIP LOCKED` — 다중 인스턴스 안전
- [x] 재시도 (fixed / exponential backoff)
- [x] 실패 이벤트 관리 (FAILED 상태, last_error 기록)
- [x] Graceful shutdown (OnApplicationShutdown)
- [x] SQL 마이그레이션 파일 제공
- [x] README + 기본 예제

### v0.2.0 이후
- [ ] PostgreSQL LISTEN/NOTIFY (실시간 이벤트 전달)
- [ ] Prisma Client Extensions 기반 통합 (스키마 모델 방식)
- [ ] @nestarc/tenancy 연동 (테넌트별 이벤트 격리)
- [ ] Inbox 패턴 (수신 이벤트 중복 처리 방지)
- [ ] 외부 브로커 어댑터 (Kafka, RabbitMQ — emit 후 status 전환)
- [ ] OpenTelemetry 트레이싱 미들웨어
- [ ] Dead letter 관리 API
- [ ] 메트릭 (처리율, 실패율, 지연 시간)
- [ ] 이벤트 순서 보장 옵션 (파티셔닝 키)

---

## 8. 프로젝트 구조

```
@nestarc/outbox/
├── src/
│   ├── index.ts                        # public API exports
│   ├── outbox.module.ts                # NestJS DynamicModule
│   ├── outbox.emitter.ts               # OutboxEmitter 구현
│   ├── outbox.poller.ts                # Polling 프로세서
│   ├── outbox.explorer.ts              # @OnOutboxEvent 리스너 탐색
│   ├── outbox.event.ts                 # OutboxEvent 추상 클래스
│   ├── outbox.decorator.ts             # @OnOutboxEvent() 데코레이터
│   ├── outbox.constants.ts             # injection tokens, 기본값
│   ├── outbox.health.ts                # health indicator (선택)
│   ├── interfaces/
│   │   ├── outbox-options.interface.ts
│   │   └── outbox-record.interface.ts
│   └── sql/
│       └── create-outbox-table.sql     # 마이그레이션 SQL
├── test/
│   ├── outbox.emitter.spec.ts
│   ├── outbox.poller.spec.ts
│   ├── outbox.explorer.spec.ts
│   ├── outbox.module.spec.ts
│   └── e2e/
│       └── outbox.e2e-spec.ts
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── .eslintrc.js
├── .prettierrc
├── LICENSE                             # MIT
└── README.md
```

---

## 9. 기술 스택 / 공통 규격

`@nestarc` 패키지 공통 규격 적용:

- **런타임**: Node.js 20+
- **NestJS**: 10.x / 11.x 호환
- **TypeScript**: 5.4+
- **ORM**: Prisma 전용 (차별화 포인트)
- **DB**: PostgreSQL 중심
- **패턴**: `forRoot()` / `forRootAsync()` 모듈 등록
- **테스트**: Jest + @nestjs/testing
- **CI/CD**: GitHub Actions → npm publish
- **라이선스**: MIT

### 의존성
- **필수 peer**: `@nestjs/common`, `@nestjs/core`, `@nestjs/schedule`, `@prisma/client`
- **내장 deps**: 없음 (Node.js crypto만 사용)

---

## 10. 핵심 구현 포인트

### 10.1 리스너 탐색 (Discovery)

NestJS의 `DiscoveryService` + `MetadataScanner`로 `@OnOutboxEvent()` 데코레이터가 붙은 메서드를 앱 부트스트랩 시 자동 탐색:

```typescript
@Injectable()
export class OutboxExplorer implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit() {
    const providers = this.discovery.getProviders();
    // OUTBOX_EVENT_METADATA 키로 데코레이터 메타데이터 조회
    // eventType → handler 맵 구성
  }
}
```

### 10.2 Polling + SKIP LOCKED

```sql
-- 원자적으로 가져오기 + 상태 변경
UPDATE outbox_events
SET status = 'PROCESSING'
WHERE id IN (
  SELECT id FROM outbox_events
  WHERE status = 'PENDING'
    AND (retry_count = 0 OR created_at < NOW() - INTERVAL '1 second' * pow(2, retry_count))
  ORDER BY created_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

- `FOR UPDATE SKIP LOCKED`: 다른 인스턴스가 이미 잡은 행은 건너뜀
- exponential backoff: `retry_count`에 따라 대기 시간 증가

### 10.3 Graceful Shutdown

```typescript
@Injectable()
export class OutboxPoller implements OnApplicationShutdown {
  private isShuttingDown = false;
  private activeProcessing = 0;

  async onApplicationShutdown() {
    this.isShuttingDown = true;
    // activeProcessing이 0이 될 때까지 대기 (타임아웃 있음)
  }
}
```

### 10.4 emit()의 타입 안전성

```typescript
// PrismaTransactionClient 타입 정의 (Prisma 버전 독립)
type PrismaTransactionClient = {
  $executeRaw: (...args: any[]) => Promise<number>;
  $queryRaw: (...args: any[]) => Promise<any>;
};
```

이렇게 하면 사용자의 Prisma 스키마에 OutboxEvent 모델이 없어도 동작.

---

## 11. 리스크 & 대응

| 리스크 | 심각도 | 대응 |
|--------|:------:|------|
| fullstackhouse가 Prisma 드라이버 추가 | 중 | 선점이 중요. MVP를 빨리 출시. |
| Prisma Interactive Transaction 제약 (타임아웃) | 중 | 문서에 타임아웃 설정 가이드 포함. 이벤트 저장은 가볍게. |
| 복잡도 (idempotency 대비 2~3배) | 상 | MVP 스코프를 polling only로 좁히기. |
| `$queryRaw` 타입 안전성 부재 | 하 | 내부에서 런타임 검증 + 테스트 커버리지로 보완. |

---

## 12. @nestarc 에코시스템 시너지 맵

```
@nestarc/tenancy       (RLS 컨텍스트)
     │ tenant_id 자동 태깅
     ▼
@nestarc/outbox        (이벤트 원자적 저장 + 전달)
     │ 이벤트 발행
     ▼
[소비자 서비스]
     │ 중복 처리 방지
     ▼
@nestarc/idempotency   (Idempotency-Key로 소비자 보호)
```

---

## 13. 참고 자료

- fullstackhouse/nestjs-outbox: https://github.com/fullstackhouse/nestjs-outbox
- Nestixis/nestjs-inbox-outbox: https://github.com/Nestixis/nestjs-inbox-outbox
- Outbox Pattern 블로그 (RabbitMQ + Postgres): https://medium.com/@sebastian.iwanczyszyn/implementing-the-outbox-pattern-in-distributed-systems-with-nestjs-rabbitmq-and-postgres-65fcdb593f9b
- Prisma Interactive Transactions: https://www.prisma.io/docs/orm/prisma-client/queries/transactions#interactive-transactions
- PostgreSQL LISTEN/NOTIFY: https://www.postgresql.org/docs/current/sql-notify.html
- FOR UPDATE SKIP LOCKED: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE

---

## 14. 다음 세션에서 할 일

1. GitHub `nestarc/outbox` 레포 생성
2. 프로젝트 스캐폴딩 (package.json, tsconfig, jest, eslint)
3. SQL 마이그레이션 파일 작성 (`create-outbox-table.sql`)
4. 인터페이스 정의 (`OutboxOptions`, `OutboxRecord`)
5. `OutboxEvent` 추상 클래스 구현
6. `OutboxEmitter` 구현 (Prisma `$executeRaw`)
7. `@OnOutboxEvent()` 데코레이터 + `OutboxExplorer` 구현
8. `OutboxPoller` 구현 (polling + retry + graceful shutdown)
9. `OutboxModule` 모듈 등록 로직
10. 단위 테스트 작성
11. E2E 테스트 (실제 PostgreSQL + Prisma)
12. README 작성
13. npm publish (`@nestarc/outbox`)

---

*이 문서는 2026-04-10 nestarc.dev 생태계 확장 리서치 세션에서 작성되었으며, Claude Code 또는 다른 세션에서 구현을 이어갈 때 컨텍스트로 활용한다.*