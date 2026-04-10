# SOLID 설계 검증 리포트

작성일: 2026-04-11
대상 프로젝트: `@nestarc/outbox`
검토 범위: `src/`, `test/`, `README.md`, 설계 문서

## 1. 결론

이 프로젝트는 전반적으로 작은 컴포넌트 단위에서는 책임 분리가 잘 되어 있고, 테스트와 문서도 비교적 잘 갖춰져 있다. 특히 `OutboxEmitter`, `OutboxExplorer`, `LocalTransport`, `OutboxEvent`는 각각의 역할이 명확하다.

다만 SOLID 관점에서 보면 "부분 준수" 수준이다. 핵심 한계는 다음 두 가지다.

1. `OutboxTransport`를 추상화해 두었지만 실제 모듈 조립에서는 `LocalTransport`가 하드코딩되어 있어 개방-폐쇄 원칙(OCP)과 의존성 역전 원칙(DIP)이 완전히 지켜지지 않는다.
2. `OutboxPoller`가 스케줄링, 조회/락킹, 재시도 정책, 상태 전이, 장애 복구까지 모두 담당하고 있어 단일 책임 원칙(SRP) 위반 소지가 크다.

종합 평가는 다음과 같다.

- S: 부분 준수
- O: 부분 준수
- L: 대체로 준수
- I: 부분 준수
- D: 부분 준수

## 2. 검증 방법

다음 항목을 기준으로 검증했다.

- 정적 검토: 핵심 소스와 공개 API, 테스트 코드, 설계 문서 비교
- 단위 테스트: `npm test -- --runInBand`
- 커버리지: `npm run test:cov -- --runInBand`
- 린트: `npm run lint`
- 빌드: `npm run build`
- E2E: `docker compose up -d` 후 `npm run test:e2e`

검증 결과:

- 단위 테스트 41개 통과
- E2E 테스트 4개 통과
- lint 통과
- build 통과
- unit coverage: statements 97.9%, branches 91.66%, functions 96.55%, lines 99.42%

## 3. 원칙별 평가

## S. Single Responsibility Principle

### 준수되는 부분

- [`src/outbox.emitter.ts`](../../src/outbox.emitter.ts): 이벤트를 outbox 테이블에 기록하는 책임만 가진다.
- [`src/outbox.explorer.ts`](../../src/outbox.explorer.ts): 핸들러 탐색과 매핑 구축만 담당한다.
- [`src/transports/local.transport.ts`](../../src/transports/local.transport.ts): in-process 핸들러 호출만 담당한다.

### 위반 또는 약한 부분

- [`src/outbox.poller.ts`](../../src/outbox.poller.ts): 아래 역할이 한 클래스에 집중되어 있다.
  - 스케줄 등록/종료 처리
  - DB에서 이벤트 조회 및 락 획득
  - 이벤트 전달 오케스트레이션
  - 성공/실패 상태 전이
  - 재시도 정책 적용
  - stuck event 복구

이 구조는 변경 이유가 너무 많다. 예를 들어 락킹 SQL 변경, 백오프 정책 변경, 복구 전략 변경, 셧다운 정책 변경이 모두 같은 클래스 수정으로 이어진다.

평가: 부분 준수

## O. Open/Closed Principle

### 준수되는 부분

- `OUTBOX_TRANSPORT` 토큰과 `OutboxTransport` 인터페이스를 두어 확장 지점을 만들려는 방향 자체는 적절하다.
- `@OnOutboxEvent()` 기반 핸들러 등록은 새로운 이벤트 타입 추가에 유리하다.

### 위반 또는 약한 부분

- [`src/outbox.module.ts:40`](../../src/outbox.module.ts#L40) 과 [`src/outbox.module.ts:63`](../../src/outbox.module.ts#L63) 에서 transport가 항상 `LocalTransport`로 고정된다.
- [`README.md:219`](../../README.md#L219) 에서도 custom transport는 미래 버전으로 미뤄져 있다.

즉, 인터페이스는 열어 두었지만 실제 조립 지점은 닫혀 있지 않다. 새 transport를 추가하려면 모듈 코드를 수정해야 하므로 OCP를 충족하지 못한다.

평가: 부분 준수

## L. Liskov Substitution Principle

### 준수되는 부분

- `OutboxEvent` 하위 타입은 `getEventType()` / `toPayload()` 계약을 충족하는 한 기본 타입으로 사용 가능하다.
- `LocalTransport`는 `OutboxTransport` 계약을 충족한다.

### 제한 사항

- 실제 DI 구성이 `LocalTransport`로 고정되어 있어, "대체 가능성"이 설계 개념 수준에 머물고 런타임 구성을 통해 검증되지는 않는다.
- 대체 transport에 대한 계약 테스트도 존재하지 않는다.

평가: 대체로 준수하나 확장 시나리오 검증은 부족

## I. Interface Segregation Principle

### 위반 또는 약한 부분

- [`src/interfaces/outbox-transport.interface.ts:4`](../../src/interfaces/outbox-transport.interface.ts#L4) 의 `dispatch(record, handlers)` 시그니처는 외부 브로커 transport에도 `handlers`를 강제한다.
- [`README.md:229`](../../README.md#L229) 의 Kafka 예시 역시 `handlers`를 받지만 사용하지 않는다.

이건 인터페이스가 두 가지 delivery 모델을 섞고 있다는 신호다.

- 로컬 전달: handler 목록 필요
- 외부 브로커 전달: handler 목록 불필요

결국 구현체가 필요 없는 인자를 받아야 하므로 ISP에 어긋난다.

또한 [`src/interfaces/outbox-options.interface.ts:15`](../../src/interfaces/outbox-options.interface.ts#L15) 의 `prisma: any`, [`src/interfaces/outbox-options.interface.ts:24`](../../src/interfaces/outbox-options.interface.ts#L24) 이하의 `inject?: any[]`, `useFactory?: (...args: any[])` 도 너무 넓은 인터페이스다. 타입 안정성을 희생해 클라이언트가 불필요하게 많은 형태를 떠안는다.

평가: 부분 준수

## D. Dependency Inversion Principle

### 준수되는 부분

- `OutboxPoller`가 transport에는 `OUTBOX_TRANSPORT` 토큰과 `OutboxTransport` 인터페이스를 통해 의존한다.
- 설정도 `OUTBOX_OPTIONS` 토큰으로 주입받는다.

### 위반 또는 약한 부분

- [`src/outbox.module.ts:40`](../../src/outbox.module.ts#L40) 과 [`src/outbox.module.ts:63`](../../src/outbox.module.ts#L63) 에서 고수준 정책이 저수준 구현(`LocalTransport`) 선택을 직접 고정한다.
- [`src/outbox.poller.ts:45`](../../src/outbox.poller.ts#L45) 에서 poller는 `OutboxExplorer` 구체 클래스에 직접 의존한다.
- [`src/interfaces/outbox-options.interface.ts:16`](../../src/interfaces/outbox-options.interface.ts#L16) 의 `prisma: any` 는 추상화라기보다 타입 회피에 가깝다.

즉, 일부 의존성은 추상화에 기대고 있지만 중요한 조립 지점과 저장소 접근은 아직 구체 구현에 묶여 있다.

평가: 부분 준수

## 4. 핵심 발견 사항

### 1. `OutboxTransport` 추상화가 실제로는 확장 불가능하다

심각도: 높음

근거:

- [`src/outbox.module.ts:40`](../../src/outbox.module.ts#L40)
- [`src/outbox.module.ts:63`](../../src/outbox.module.ts#L63)

설명:

프로젝트는 transport를 추상화했지만, 소비자는 이를 주입해 교체할 수 없다. 따라서 새 broker transport를 추가할 때 기존 모듈 구현 수정이 필요하다. 이는 OCP/DIP 측면에서 가장 큰 제약이다.

### 2. `OutboxTransport` 인터페이스가 delivery 모델을 분리하지 못한다

심각도: 중간

근거:

- [`src/interfaces/outbox-transport.interface.ts:4`](../../src/interfaces/outbox-transport.interface.ts#L4)
- [`src/transports/local.transport.ts:8`](../../src/transports/local.transport.ts#L8)
- [`README.md:229`](../../README.md#L229)

설명:

외부 브로커 transport는 `handlers`가 필요 없는데도 인터페이스가 이를 강제한다. 현재 인터페이스는 "로컬 핸들러 호출"과 "메시지 발행"이라는 서로 다른 책임을 한 계약에 섞어 두고 있다. ISP 위반이며 향후 확장 시 구현체가 억지로 불필요한 인자를 받게 된다.

### 3. `OutboxPoller`가 너무 많은 변경 이유를 가진다

심각도: 중간

근거:

- [`src/outbox.poller.ts:28`](../../src/outbox.poller.ts#L28)
- [`src/outbox.poller.ts:56`](../../src/outbox.poller.ts#L56)
- [`src/outbox.poller.ts:136`](../../src/outbox.poller.ts#L136)
- [`src/outbox.poller.ts:197`](../../src/outbox.poller.ts#L197)
- [`src/outbox.poller.ts:232`](../../src/outbox.poller.ts#L232)

설명:

폴러는 스케줄러, 저장소, 재시도 정책, 상태 전이, 복구 로직을 모두 안고 있다. 현재 규모에서는 동작하지만, 기능이 조금만 늘어나도 클래스 응집도가 빠르게 떨어질 구조다.

### 4. 옵션/저장소 추상화의 타입 경계가 약하다

심각도: 낮음

근거:

- [`src/interfaces/outbox-options.interface.ts:16`](../../src/interfaces/outbox-options.interface.ts#L16)
- [`src/interfaces/outbox-options.interface.ts:25`](../../src/interfaces/outbox-options.interface.ts#L25)

설명:

`any` 중심 옵션 계약은 빠르게 구현할 때는 편하지만, 장기적으로는 DIP/ISP보다 "구현 상세 누수"에 가깝다. 특히 라이브러리 패키지라면 소비자 경험과 컴파일 타임 검증 품질이 더 중요하다.

## 5. 강점

- 테스트가 촘촘하다. 단위 테스트와 E2E 모두 존재하고, 핵심 시나리오를 잘 덮는다.
- 공개 API가 작고 이해하기 쉽다.
- `OutboxEmitter`, `OutboxExplorer`, `LocalTransport`는 역할이 비교적 명확하다.
- `FOR UPDATE SKIP LOCKED`, stuck recovery, graceful shutdown 등 운영 관점의 필수 요소가 구현돼 있다.

## 6. 개선 권장안

우선순위 순으로 제안한다.

1. `OutboxModule` 에 `transport` 또는 `transportProvider` 옵션을 추가해 `LocalTransport` 하드코딩을 제거한다.
2. `OutboxTransport` 를 둘로 나눈다.
   - 예: `OutboxDispatcher` 는 로컬 핸들러 실행 담당
   - 예: `OutboxPublisher` 는 `OutboxRecord` 발행 담당
3. `OutboxPoller` 를 분리한다.
   - `OutboxRepository`
   - `RetryPolicy`
   - `StuckEventRecovery`
   - `PollScheduler` 또는 `PollingLifecycle`
4. `OutboxExplorer` 대신 `HandlerRegistry` 인터페이스를 두고 poller는 그 추상화에만 의존하게 만든다.
5. `OutboxOptions.prisma` 와 async 옵션의 `any` 를 `PrismaLike` 또는 더 좁은 계약으로 대체한다.

## 7. 최종 판단

현재 구현은 "동작하는 MVP"로서는 충분히 안정적이고, 테스트 품질도 높다. 그러나 SOLID를 엄격히 기준으로 삼으면, 핵심 확장 지점인 transport와 poller 구조에서 원칙이 완전히 지켜졌다고 보기는 어렵다.

따라서 최종 평가는 다음과 같다.

- 기능 품질: 양호
- 테스트 품질: 우수
- SOLID 준수 수준: 보통 이상, 다만 핵심 확장성 측면에서 보완 필요

즉, "SOLID를 의식하며 설계된 프로젝트"로는 볼 수 있지만, "SOLID를 충분히 준수한 구현"이라고 결론 내리기에는 아직 이르다.
