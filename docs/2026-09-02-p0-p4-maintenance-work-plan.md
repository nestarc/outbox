# `@nestarc/outbox` v0.2.1 이후 P0–P4 유지보수 작업 계획

- 상태: `ACTIVE`
- 작성일: 2026-09-02 (Asia/Seoul)
- 공개 기준: `origin/main@873f95bd86682d4b9515d743efbcfc093a88f450`, `v0.2.1`
- 조사 checkout: `codex/ten-m21-outbox-modern@a735029431af823976f8653c9ab36cfa3d29e5ea`
- tree hash: 공개 기준과 조사 checkout 모두 `4345b7d8dc8a9a4985a10fd4e036afebbd0c5152`
- 패키지: `@nestarc/outbox@0.2.1`
- 목적: 조사에서 확인한 P0–P4 작업을 **한 세션에 한 작업, 한 PR** 단위로 나누고, 새 세션이 기준선·완료 작업·선행 결정을 다시 조사하지 않도록 한다.

> [!IMPORTANT]
> 새 작업은 현재 topic branch가 아니라 fetch한 `origin/main`에서 시작한다. 조사 checkout은 공개 기준과 tree가 같지만 commit lineage가 다르다. `TEN-M21`은 완료됐으며 재개하거나 ID를 재사용하지 않는다.

> [!IMPORTANT]
> 이 파일은 작성 직후 `untracked` 상태다. 구현 작업보다 먼저 `OUT-PLAN-01`로 이 문서만 review/merge해야 clean checkout과 여러 세션이 같은 상태를 공유할 수 있다. 문서가 `origin/main`에 들어가기 전에는 다른 task를 `IN_PROGRESS`로 바꾸지 않는다.

> [!CAUTION]
> 현재 구현은 end-to-end exactly-once와 global/aggregate FIFO를 보장하지 않는다. Outbox 전달은 at-least-once이고 소비자는 멱등해야 한다. 이 문서의 P0는 거짓 보장을 제거하고 claim 안전성을 높이는 작업이지 exactly-once를 약속하는 작업이 아니다.

## 0. 문서 운영 계약

### 0.1 우선순위

| 우선순위 | 의미                                                                                | 실행 원칙                                                                              |
| -------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `P0`     | 공개 전달 계약을 현재 깨뜨리거나 행 상태를 오염·경쟁시킬 수 있는 재현된 결함        | 다른 기능보다 먼저 처리한다. 독립적인 P0는 병렬 가능하지만 P1–P4 때문에 미루지 않는다. |
| `P1`     | tenant 경계, retry/lifecycle, DI, 릴리스 신뢰 또는 선언된 지원 범위를 약화하는 문제 | P0 뒤에 한 계약씩 처리한다.                                                            |
| `P2`     | schema 진단, 관리 API, 문서, 패키징, 테스트 깊이와 운영성 개선                      | P0/P1 계약을 바꾸지 않는 범위에서 진행한다.                                            |
| `P3`     | 구조·도구·장기 유지보수 개선                                                        | 별도 ADR/스파이크로 시작하고 현재 patch release를 막지 않는다.                         |
| `P4`     | 제품 확장 또는 장기 연구                                                            | `BACKLOG`만 유지한다. 구현 승격에는 별도 제품 결정이 필요하다.                         |

### 0.2 상태

| 상태          | 의미                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `READY`       | 선행 조건이 충족되어 바로 시작할 수 있다.                                                                                  |
| `IN_PROGRESS` | 한 세션이 소유 중이다. shared issue/PR에 owner·시작 ref·시각을 기록하며 branch-local 문서 변경만으로는 lock이 되지 않는다. |
| `BLOCKED`     | 표에 적힌 선행 작업이나 외부 조건이 필요하다.                                                                              |
| `DECISION`    | 구현 전 호환성·semver·운영 정책 ADR을 이 작업 안에서 확정해야 한다.                                                        |
| `EXTERNAL`    | 다른 저장소 또는 GitHub/npm 관리자 권한에서 수행한다.                                                                      |
| `DONE`        | 코드, 문서, 검증, 필요한 배포 증거까지 완료됐다.                                                                           |
| `SUPERSEDED`  | 다른 작업에 흡수되어 다시 실행하지 않는다.                                                                                 |
| `BACKLOG`     | P4 연구 후보이며 실행 큐가 아니다.                                                                                         |

### 0.3 새 세션 시작 절차

1. 이 문서와 현재 `git status --short --branch`를 먼저 읽는다.
2. 기존 수정·미추적 파일의 소유권을 보존한다. 임의로 reset, restore, delete, stage하지 않는다.
3. `git fetch --tags origin main:refs/remotes/origin/main` 후 `origin/main`, release tag, npm `latest`를 다시 확인한다. 기준이 달라졌다면 코드보다 이 문서의 기준선과 task 상태부터 갱신한다.
4. `OUT-PLAN-01` merge를 확인한 뒤 공개 기준에서 `codex/out-mxx-<slug>` branch 또는 별도 worktree를 만든다. 조사 topic branch에서 이어서 구현하지 않는다.
5. 한 세션은 현재 최저 미완료 priority의 가장 낮은 번호 `READY` 또는 `DECISION` 하나만 선택한다. shared issue/PR에 task ID, owner, start ref, 시작 시각을 먼저 기록하고 나서 `IN_PROGRESS`로 바꾼다. branch-local plan 변경만으로 task를 claim하지 않는다. stale claim은 owner/PR/session이 실제로 종료됐음을 확인한 뒤에만 회수한다. P0 merge 뒤 `OUT-REL-01`의 직접 선행 `OUT-M09`, `OUT-M12`, `OUT-M13`, `OUT-M19`, `OUT-M21`은 unrelated 작업보다 먼저 당길 수 있고, 선행이 모두 끝나면 `OUT-REL-01`을 실행한다.
6. 각 작업의 “첫 RED”를 먼저 재현한다. 재현되지 않으면 원인을 기록하고 작업 범위를 조용히 바꾸지 않는다.
7. 작업별 검증 프로필과 `git diff --check`를 실행한 뒤 인계 기록을 남긴다.

시작용 최소 명령:

```bash
git status --short --branch
git fetch --tags origin main:refs/remotes/origin/main
git rev-parse origin/main
git rev-parse v0.2.1^{}
git log -1 --oneline origin/main
gh release view v0.2.1 --json tagName,targetCommitish,publishedAt
npm view @nestarc/outbox version gitHead dist.integrity time --json
node -p "require('./package.json').version"
```

`gh` 인증이 없으면 release/CI 조회 실패를 0건으로 해석하지 말고 public GitHub API/Actions page로 fetched SHA를 확인하거나 “외부 검증 미완료”로 인계한다. source test는 새 worktree/branch에서 프로필 A로 실행한다.

### 0.4 세션 종료 인계 형식

작업을 끝내거나 중단할 때 해당 작업의 상태와 문서 맨 아래 작업 기록을 함께 갱신한다.

```text
Task: OUT-Mxx
State: DONE | BLOCKED | IN_PROGRESS | DECISION | EXTERNAL
Start ref / end ref:
Changed files:
Contract / semver decision:
Commands and exact results:
Unverified paths and reason:
External PR, run, release evidence:
Remaining risk:
Next exact action:
```

코드가 작성됐거나 unit test만 통과했다는 이유로 `DONE` 처리하지 않는다. PostgreSQL, packed consumer, release/settings 증거가 완료 조건이면 실제 결과가 있어야 한다.

## 1. 2026-09-02 기준선

### 1.1 저장소와 배포 상태

- 공개 main과 `v0.2.1` commit은 `873f95b`; annotated tag object는 별도지만 dereference한 commit은 동일하다.
- 조사 checkout `a735029`는 공개 main과 tree가 동일하므로 TEN-M21 코드를 다시 merge하거나 cherry-pick하지 않는다.
- 조사 시작 시 worktree는 clean이었다. 이 계획 파일만 새 파일로 추가한다.
- npm `latest`는 `0.2.1`이며 2026-08-30T05:04:29.341Z에 게시됐다.
- [GitHub Release v0.2.1](https://github.com/nestarc/outbox/releases/tag/v0.2.1), [release run 33293676629](https://github.com/nestarc/outbox/actions/runs/33293676629), npm provenance/attestation은 완료된 기준선이다.
- release tarball은 97 entries, packed 33,383 bytes, unpacked 147,508 bytes였고 fresh pack과 registry integrity가 일치했다. 이 증거를 재구현하지 않고 이후 artifact gate의 기준으로 쓴다.

### 1.2 fresh 검증

조사 환경 Node `24.11.1`에서 실행했다.

| 검증                                      | 결과                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `npm test -- --runInBand`                 | 9 suites, 88 tests PASS                                            |
| `npm run lint`                            | PASS                                                               |
| `npx tsc --noEmit -p tsconfig.build.json` | PASS                                                               |
| `npm run test:cov`                        | statements 94.72%, branches 83.48%, functions 97.70%, lines 95.42% |
| `npm audit --omit=dev --json`             | production 0                                                       |
| `npm audit --json`                        | 10 total: high 7, moderate 1, low 2; 모두 dev/test/build tree      |

이번 조사에서는 PostgreSQL Docker가 떠 있지 않아 fresh `test:e2e`를 실행하지 않았다. v0.2.1 release와 main CI의 성공은 외부 기준 증거지만, DB 상태 머신을 바꾸는 작업은 자기 branch에서 E2E를 다시 실행해야 한다.

### 1.3 선언과 자동 증거

| 축         | 공개 선언                               | 현재 자동 증거                         | 유지보수 결론                                                                |
| ---------- | --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Node       | `>=20`                                  | CI Node 20/22, publish Node 24         | Node 20 EOL 이후 정책은 `OUT-M14`에서 결정한다.                              |
| NestJS     | 10/11                                   | exact 10.4.22, 11.2.1                  | Nest 12는 peer 확대 전 strict packed PostgreSQL 증거가 필요하다.             |
| Schedule   | 4/5                                     | Nest 10×Schedule 4, Nest 11×Schedule 5 | Nest 12와 함께 현재 조합을 재검증한다.                                       |
| Prisma     | 5/6/7                                   | exact 6.19.3, 7.10.0                   | Prisma 5 선언과 CI가 불일치한다. `OUT-M13`이 소유한다.                       |
| PostgreSQL | transactional SQL implementation        | PostgreSQL 16 CI/release               | 최소 지원 버전은 운영 문서에서 명시하고 migration 경로를 실제 DB로 검증한다. |
| package    | CommonJS root + deep-resolved SQL files | modern packed consumer                 | 명시적 `exports` 여부는 `OUT-M23`에서 ADR 후 결정한다.                       |

Node lifecycle 판단은 [Node.js 공식 release schedule](https://github.com/nodejs/Release#release-schedule)을 기준으로 한다. 새 Nest/Prisma major는 “현재 최신”이라는 이유만으로 peer range에 먼저 추가하지 않는다.

### 1.4 확인된 전달 모델

- claim 후 callback 성공과 `SENT` 기록 사이의 process loss는 중복 전달을 만들 수 있다.
- local transport에서 여러 handler 중 일부 side effect가 성공한 뒤 다음 handler가 실패하면 retry 때 앞 handler도 다시 실행될 수 있다.
- `idempotency_key`는 현재 metadata column이며 producer/consumer uniqueness를 보장하지 않는다.
- `partition_key`와 aggregate index는 strict FIFO 구현이 아니다.
- Outbox `SENT`는 publisher가 전달을 수락했다는 뜻이지 downstream Jobs handler 성공을 뜻하지 않는다.
- hook은 best-effort observation이며 compliance-grade durable audit의 단독 근거가 아니다.

### 1.5 완료되어 다시 열지 않는 범위

- `TEN-M19`, `TEN-M21` published/local ecosystem provenance와 modern/legacy fully-published 검증
- v0.2.0 publisher mode, metadata, admin/DLQ, tenancy provider, hooks, LISTEN/NOTIFY wakeup, bulk emit
- v0.2.1 Prisma 7 + Nest 11 packed consumer와 preserved Nest 10 + Prisma 6 release lanes
- poll shutdown의 기존 `pollInFlight` race 수정, per-record `maxRetries`, no-handler → `FAILED`, hook exception swallowing
- 현재 admin dynamic SQL은 SQL 구조를 내부에서 만들고 값은 bind한다. `$queryRawUnsafe`라는 이름만으로 injection 재작성 task를 만들지 않는다.
- exactly-once, strict global FIFO, strict aggregate FIFO는 완료 기능이 아니다. 각각 이 문서의 비보장 또는 P4 연구 범위다.

`docs/handover.md`, 과거 superpowers plan/spec, SOLID report의 체크박스는 역사적 증거다. 새 세션의 backlog는 이 문서만 권위 있게 사용한다.

### 1.6 조사 evidence map

아래 line은 이 기준 tree에서의 시작점이다. 새 세션에서 line이 이동했으면 symbol을 다시 찾되 finding을 과거 line 번호에 억지로 맞추지 않는다.

| 작업         | 현재 evidence                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OUT-M01`    | mutable callback dispatch와 callback-owned ID 재사용: `src/outbox.poller.ts:134-158`, `:168-208`; ID-only terminal/retry writes: `:261-317`       |
| `OUT-M02`    | batch 중 shutdown break: `src/outbox.poller.ts:132-136`; ownerless recovery: `:324-333`                                                           |
| `OUT-M03`    | dropped interval Promise: `src/outbox.poller.ts:82-86`; overlapping poll counter only: `:116-165`; LISTEN만 catch: `src/outbox.listener.ts:60-65` |
| `OUT-M05`    | process-local backoff로 eligibility 계산: `src/outbox.poller.ts:212-237`                                                                          |
| `OUT-M06`    | explicit tenant property presence resolution: `src/outbox.emitter.ts:198-207`                                                                     |
| `OUT-M07/08` | global admin read/mutation surface: `src/outbox.admin.service.ts:41-243`                                                                          |
| `OUT-M09`    | boot-blocking connect와 reconnect ownership: `src/outbox.listener.ts:36-75`, `:105-117`                                                           |
| `OUT-M10`    | unvalidated runtime option surface: `src/interfaces/outbox-options.interface.ts:8-42`                                                             |
| `OUT-M11`    | top-level async transport/global ownership: `src/outbox.module.ts:79-113`; bare tenant provider construction: `:139-150`                          |
| `OUT-M12/21` | manual release input/check: `.github/workflows/release.yml:37-85`; fresh publish rebuild/privileged release: `:176-239`                           |
| `OUT-M13`    | declared Prisma majors vs 6/7 matrix: `package.json:48-54`, `.github/workflows/ci.yml:82-101`                                                     |
| `OUT-M04A`   | false absolute guarantee: `README.md:391-398`; actual at-least-once spec: `docs/superpowers/specs/2026-06-17-outbox-0.2.0-spec.md:715-739`        |

## 2. 실행 큐

| 순서 | ID             | 우선순위 | 상태       | 크기 | 선행                                                                                 | 작업                                                                |
| ---: | -------------- | -------- | ---------- | ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
|    0 | `OUT-PLAN-01`  | 문서     | `READY`    | S    | 없음                                                                                 | 이 계획만 별도 PR로 review/merge                                    |
|    1 | `OUT-M04A`     | P0       | `READY`    | S    | 없음                                                                                 | at-least-once 전달 계약 긴급 정정                                   |
|    2 | `OUT-M01`      | P0       | `DONE`     | L    | 없음                                                                                 | 불변 claim identity와 fenced 상태 전이                              |
|    3 | `OUT-M02`      | P0       | `DONE`     | L    | `OUT-M01`, `OUT-M03`                                                                 | lease/heartbeat/recovery와 미시작 claim 반납                        |
|    4 | `OUT-M03`      | P0       | `DONE`     | M    | 없음                                                                                 | poll single-flight, coalescing, background 오류 격리                |
|    5 | `OUT-M04B`     | P0       | `READY`    | L    | `OUT-M01–03`                                                                         | 실제 PostgreSQL 다중 poller/crash-window gate                       |
|    6 | `OUT-M05`      | P1       | `READY`    | M    | `OUT-M01`                                                                            | `next_attempt_at` 기반 영속 retry 시각                              |
|    7 | `OUT-M06`      | P1       | `DECISION` | M    | 없음                                                                                 | tenant producer provenance 정책                                     |
|    8 | `OUT-M07`      | P1       | `BLOCKED`  | M    | `OUT-M06`, `OUT-M08`                                                                 | privileged/tenant-safe admin 경계                                   |
|    9 | `OUT-M08`      | P1       | `BLOCKED`  | M    | `OUT-M01–02`, `OUT-M05`                                                              | admin 상태 전이 CAS                                                 |
|   10 | `OUT-M09`      | P1       | `BLOCKED`  | M    | `OUT-M03`                                                                            | LISTEN/NOTIFY degrade/reconnect lifecycle                           |
|   11 | `OUT-M10`      | P1       | `READY`    | M    | 없음                                                                                 | runtime option/state invariant validation                           |
|   12 | `OUT-M11`      | P1       | `READY`    | M    | 없음                                                                                 | `forRootAsync` DI와 async option 계약                               |
|   13 | `OUT-M12`      | P1       | `READY`    | M    | 없음                                                                                 | release authorization, least privilege, immutable actions           |
|   14 | `OUT-M13`      | P1       | `READY`    | M    | 없음                                                                                 | Prisma 5 지원 선언 증거 복구                                        |
|   15 | `OUT-M14`      | P1       | `DECISION` | M    | 없음                                                                                 | Node LTS/Nest 12 현재 지원 정책                                     |
|   16 | `OUT-M21`      | P1       | `BLOCKED`  | M    | `OUT-M12`                                                                            | pack-once, exact artifact publish/provenance                        |
|   17 | `OUT-M15`      | P2       | `READY`    | S    | `OUT-M01`                                                                            | hook의 불변성·commit 의미 문서화                                    |
|   18 | `OUT-M16`      | P2       | `READY`    | M    | 없음                                                                                 | envelope·JSON·bulk 입력 계약                                        |
|   19 | `OUT-M17`      | P2       | `READY`    | S    | 없음                                                                                 | ordering 비보장과 deterministic cursor 계약                         |
|   20 | `OUT-M18`      | P2       | `BLOCKED`  | M    | `OUT-M05`, `OUT-M07–08`, `OUT-M17`                                                   | admin pagination/retention/bulk 성능                                |
|   21 | `OUT-M19`      | P2       | `BLOCKED`  | L    | `OUT-M01–02`, `OUT-M05`, `OUT-M10`                                                   | schema upgrade/diagnostic compatibility                             |
|  22A | `OUT-M20A`     | P2       | `BLOCKED`  | M    | `OUT-M01`, `OUT-M05–06`, `OUT-M10`                                                   | publisher terminal/tenant-context PostgreSQL E2E                    |
|  22B | `OUT-M20B`     | P2       | `BLOCKED`  | M    | `OUT-M03`, `OUT-M09`                                                                 | LISTEN/NOTIFY wakeup/fallback PostgreSQL E2E                        |
|  22C | `OUT-M20C`     | P2       | `BLOCKED`  | M    | `OUT-M02`, `OUT-M05`, `OUT-M19`                                                      | shutdown/retry/upgrade 통합 PostgreSQL E2E                          |
|   23 | `OUT-M22`      | P2       | `READY`    | M    | 없음                                                                                 | dev dependency audit remediation                                    |
|   24 | `OUT-M23`      | P2       | `DECISION` | M    | 없음                                                                                 | explicit root/SQL package export 계약                               |
|   25 | `OUT-M24`      | P2       | `READY`    | S    | 없음                                                                                 | 과거 문서 권위와 현재 handover 정리                                 |
|   26 | `OUT-M25`      | P2       | `BLOCKED`  | M    | `OUT-M06`, `OUT-M11`, `OUT-M23`                                                      | typechecked packed examples                                         |
|   27 | `OUT-M26`      | P2       | `BLOCKED`  | S    | `OUT-M01–02`, `OUT-M08–09`, `OUT-M20A–C`                                             | critical branch coverage gate                                       |
|   28 | `OUT-M27`      | P3       | `READY`    | M    | 없음                                                                                 | benchmark harness 복구                                              |
|   29 | `OUT-M28`      | P3       | `DECISION` | S    | 없음                                                                                 | sourcemap/source packaging 계약                                     |
|   30 | `OUT-M29`      | P3       | `BLOCKED`  | M    | `OUT-M02`, `OUT-M04A–05`, `OUT-M12`, `OUT-M18`                                       | SECURITY/support/operations runbook                                 |
|   31 | `OUT-M30`      | P3       | `BLOCKED`  | M    | `OUT-M13–14`, `OUT-M21`                                                              | compatibility version manifest와 drift check                        |
|   32 | `OUT-M31`      | P3       | `BLOCKED`  | M    | `OUT-M01–11`                                                                         | poller 내부 책임 분리                                               |
|   33 | `OUT-REL-01`   | release  | `BLOCKED`  | M    | `OUT-M01–03`, `OUT-M04A–B`, `OUT-M05`, `OUT-M09`, `OUT-M12–13`, `OUT-M19`, `OUT-M21` | next version/CHANGELOG/tag/publish                                  |
|   34 | `TEN-ECO-NEXT` | 외부     | `EXTERNAL` | L    | `OUT-REL-01`, `JOBS-REL-01`                                                          | PostgreSQL Outbox → Redis/BullMQ fully-published crash/restart 검증 |

먼저 `OUT-PLAN-01`을 끝낸다. 공개 보장 정정인 `OUT-M04A`를 즉시 처리하고, `OUT-M01`과 `OUT-M03`을 독립 PR로 진행한 뒤 둘을 rebase/merge한 최신 main에서 `OUT-M02`, 이어서 `OUT-M04B`를 수행한다. P0를 한 PR로 합치지 않는다.

### 2.1 파일과 첫 RED 행동

| ID         | 주 파일/경계                                              | 새 세션의 정확한 첫 행동                                                                                                                                   |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OUT-M01`  | `src/outbox.poller.ts`, hook/transport/local context, SQL | hook이 claimed row A의 `record.id`를 B로 바꿨을 때 terminal UPDATE가 B를 건드리고 A가 PROCESSING으로 남는 현재 재현을 고정한다.                            |
| `OUT-M02`  | poller recovery, schema/upgrade SQL                       | blocking publisher와 작은 lease로 두 poller가 같은 row를 동시에 dispatch하는 PostgreSQL test를 먼저 만든다.                                                |
| `OUT-M03`  | poll timer, listener trigger, coordinator                 | `$queryRaw` reject를 timer가 호출할 때 `unhandledRejection`이 발생하는 test와 notification burst max-concurrency test를 만든다.                            |
| `OUT-M04A` | README, guarantee section                                 | README의 “No event is ever processed twice concurrently”를 현재 코드/0.2 spec과 대조한 보장 표를 먼저 작성한다.                                            |
| `OUT-M04B` | `test/e2e`, release gate                                  | two-poller/slow-publisher/ack-before-SENT process-loss fixture를 RED로 추가한다.                                                                           |
| `OUT-M05`  | eligibility SQL, failure transition, index                | 서로 다른 backoff 설정의 두 poller가 같은 실패 row의 due time을 다르게 계산하는 test를 만든다.                                                             |
| `OUT-M06`  | emitter tenant resolution                                 | `{tenantId: undefined}`가 provider fallback을 우회해 NULL을 저장하는 test를 고정한다.                                                                      |
| `OUT-M07`  | admin service/API/docs                                    | tenant A scope로 B row의 get/retry/mark/purge가 가능한 현재 contract E2E를 만든다.                                                                         |
| `OUT-M08`  | admin transition SQL                                      | active row를 admin `markFailed`한 뒤 poller가 `SENT`로 되돌리는 race를 재현한다.                                                                           |
| `OUT-M09`  | listener lifecycle                                        | optional connection failure가 module init을 reject하는 test와 reconnect 뒤 old client `end()`가 0회인 test를 만든다.                                       |
| `OUT-M10`  | options validator/module                                  | negative `stuckThreshold`, zero batch, NaN interval이 module init을 통과하는 표를 RED로 만든다.                                                            |
| `OUT-M11`  | dynamic module provider graph                             | constructor dependency가 필요한 tenant provider를 `forRootAsync`로 등록해 dependency가 `undefined`인 test를 만든다.                                        |
| `OUT-M12`  | release workflow/settings                                 | manual dispatch 기본값으로 tag가 아닌 SHA가 실제 publish path에 들어가는 workflow fixture를 만든다.                                                        |
| `OUT-M13`  | CI/release matrix, consumer                               | exact Prisma 5.22 packed PostgreSQL consumer를 추가해 첫 install/type/runtime 실패를 기록한다.                                                             |
| `OUT-M14`  | engines/peers/matrix/README                               | Node 22/24 × exact Nest 12/Schedule 6 또는 현재 호환 조합의 strict consumer 결과를 ADR 입력으로 기록한다.                                                  |
| `OUT-M15`  | hooks docs/tests                                          | caller-owned transaction rollback인데 `onEmit`이 이미 호출되는 test와 observer mutation isolation test를 고정한다.                                         |
| `OUT-M16`  | emitter/record validation, bulk SQL                       | circular/BigInt가 native JSON 오류로 새고 Invalid Date가 `null`이 되는 현상, oversized metadata와 bind-limit 초과를 stable package error table로 고정한다. |
| `OUT-M17`  | SQL comments, README, admin cursor                        | 동일 `created_at` row 여러 개에서 date-only pagination이 누락/중복되는 test를 만든다.                                                                      |
| `OUT-M18`  | admin list/retry/stats/indexes                            | 동일 timestamp cursor, 대량 retry, full-table stats에 대한 fixture와 `EXPLAIN ANALYZE` 기준을 먼저 기록한다.                                               |
| `OUT-M19`  | fresh/upgrade SQL, schema check                           | v0.1, v0.2 schema에 새 runtime을 올렸을 때 첫 generic SQL failure를 fixture로 만든다.                                                                      |
| `OUT-M20A` | real PostgreSQL publisher/tenant E2E                      | 현재 E2E와 누락 시나리오를 1:1 표로 만든 뒤 provider-derived tenant/context 또는 final FAILED의 첫 missing case를 RED로 추가한다.                          |
| `OUT-M20B` | real PostgreSQL notification E2E                          | LISTEN 선행 wakeup과 notification loss fallback을 deterministic barrier로 분리해 첫 missing case를 RED로 추가한다.                                         |
| `OUT-M20C` | real PostgreSQL lifecycle/upgrade E2E                     | upgraded schema에서 mixed retry config와 shutdown 미시작 claim 회수를 함께 실행해 첫 통합 실패를 기록한다.                                                 |
| `OUT-M21`  | CI/release artifact graph                                 | verify job이 검사한 tree와 publish job이 재빌드한 tgz digest가 달라도 publish 가능한 graph를 test/diagram으로 고정한다.                                    |
| `OUT-M22`  | package lock/toolchain                                    | production/dev advisory를 경로별로 분류하고 안전한 compatible update 하나만 적용하는 PR부터 시작한다.                                                      |
| `OUT-M23`  | package manifest/packed consumers                         | npm tarball의 실제 deep imports를 조사하고 root/SQL/accidental path consumer를 RED fixture로 만든다.                                                       |
| `OUT-M24`  | old handover/spec/plans                                   | 현재 release와 모순되는 문장만 목록화하고 각 문서 상단에 넣을 historical banner를 작성한다.                                                                |
| `OUT-M25`  | example fixtures                                          | README local/publisher/tenancy/SQL 예제를 tarball에서 compile/run하는 최소 consumer를 만든다.                                                              |
| `OUT-M26`  | Jest/workflow                                             | admin/listener critical branch의 현재 수치와 미검증 branch를 목록화한다.                                                                                   |
| `OUT-M27`  | bench, Prisma client                                      | 현 Prisma 7로 benchmark compile/smoke가 실패하는 첫 오류를 기록한다.                                                                                       |
| `OUT-M28`  | `.js.map`, tarball                                        | packed map이 포함되지 않은 `src/*.ts`를 가리키는 assertion을 먼저 만든다.                                                                                  |
| `OUT-M29`  | policy/runbook                                            | 지원 release line, private reporting channel, lease/backlog 운영 책임을 owner와 확정한다.                                                                  |
| `OUT-M30`  | shared compatibility data                                 | package/CI/release/script에 중복된 exact version 값을 표로 만들고 한 값을 바꿨을 때 drift test가 실패하게 한다.                                            |
| `OUT-M31`  | poller internals                                          | P0 contract tests를 refactor 전 고정하고 public API 변화 없는 extraction boundary를 ADR로 그린다.                                                          |

### 2.2 `OUT-PLAN-01` — 계획 bootstrap

- 이 파일 하나만 path-scoped stage한 plan-only PR을 만든다. code, lockfile, 기존 docs를 함께 넣지 않는다.
- reviewer가 기준 ref, 공개 release, P0 evidence, task dependency, destructive test guard를 확인한다.
- reviewer 승인 뒤 merge될 최종 commit에서 이 row를 `DONE`으로 바꾼다. 따라서 `origin/main`에는 `READY` 상태의 bootstrap row가 노출되지 않으며 별도 상태-only PR을 만들지 않는다.
- merge 뒤 clean `origin/main` worktree에서 이 문서를 읽을 수 있음을 확인한다.
- 현재 요청은 문서 생성까지만 소유하므로 commit/push/PR은 별도 승인된 세션에서 수행한다.

## 3. P0 작업 명세

### `OUT-M01` — 불변 claim identity와 fenced 상태 전이

- 상태: `P0 / DONE`
- 문제: claim은 `PROCESSING + updated_at`만 기록하고 `markSent`, retry, failed 전이는 `id`만 조건으로 쓴다. hook/transport/handler가 같은 mutable record를 받아 `id`, retry count, tenant/payload를 바꿀 수 있으며 poller가 callback 이후 그 객체에서 상태 전이 키를 다시 읽는다.
- 범위: claim token/lease version의 최소 내부 모델, 원본 event ID 캡처, callback snapshot, 모든 terminal/retry CAS, lost-claim 결과.

완료 조건:

- [x] 상태 전이는 `id + PROCESSING + claim token/version`을 모두 검증한다.
- [x] 최소 `claim_token` column/index와 fresh/current-version upgrade SQL은 이 작업이 소유하고 PostgreSQL stale-token test에 사용한다.
- [x] claim token은 publisher용 public `OutboxRecord`에 노출하지 않는다.
- [x] hook, publisher, local handler에는 canonical row와 참조를 공유하지 않는 detached deep snapshot과 readonly public type을 전달한다. runtime-frozen object 호환성을 새로 약속하지 않는다.
- [x] callback이 record의 id/status/retry/maxRetries/tenant/payload를 바꿔도 다른 행과 canonical 상태가 오염되지 않는다.
- [x] CAS 0 rows는 lost claim으로 취급하며 success/failure/dead-letter hook을 거짓으로 내보내지 않는다.
- [x] queued, terminal, stale claim의 illegal transition 표를 contract test로 고정한다.
- [x] unit + PostgreSQL stale-token tests가 통과한다.
- [x] schema/public type 변화의 semver 결정을 CHANGELOG/ADR에 남긴다.

검증: 프로필 A/B/C. 비범위: heartbeat 정책, exactly-once, strict FIFO.

### `OUT-M02` — lease/heartbeat/stuck recovery와 미시작 claim 반납

- 상태: `P0 / DONE`; 선행 `OUT-M01`, `OUT-M03`
- 문제: 오래된 모든 PROCESSING row를 owner 확인 없이 PENDING으로 되돌린다. 긴 handler나 batch 뒤쪽 row가 threshold를 넘으면 다른 poller가 같은 event를 동시에 처리할 수 있다. crash recovery가 retry budget을 소비하지 않는 의미도 불명확하다.

완료 조건:

- [x] `OUT-M01`의 `claim_token` 위에 `lease_expires_at` 또는 동등한 lease 정보를 additive schema/migration으로 추가한다.
- [x] recovery는 만료 lease만 회수하고 이전 claimant의 늦은 write는 거부한다.
- [x] active callback의 lease heartbeat를 구현한다. 아직 callback을 시작하지 않은 batch row는 claim-on-demand/bounded claim 또는 동등한 명시 전략으로 lease가 시작 전에 만료되지 않게 한다.
- [x] lease duration, `heartbeatInterval < leaseDuration / 2`, heartbeat 실패 허용 횟수, 영구 hang/process crash 회수 시점, 현재 `stuckThreshold`의 호환/이행, retry budget 의미를 option/state 표로 고정한다.
- [x] `OUT-M04A`의 현재-race 설명에 새 lease/heartbeat loss와 stale completion 의미를 갱신한다.
- [x] shutdown은 아직 callback을 시작하지 않은 자기 claim을 자기 token으로 반납한다.
- [x] two-poller long-handler test에서 같은 event의 동시 callback 수가 1을 넘지 않는다.
- [x] process loss 뒤 lease 만료 후 eventual retry가 된다.
- [x] fresh install SQL과 upgrade SQL을 함께 제공한다.

검증: 프로필 B/C/E. 비범위: 외부 side effect exactly-once.

### `OUT-M03` — poll single-flight와 background 오류 격리

- 상태: `P0 / DONE`
- 문제: interval callback이 `poll()` Promise를 버려 DB rejection이 unhandled가 되고, timer와 LISTEN notification이 겹치면 동일 프로세스 poll이 제한 없이 중첩될 수 있다.

완료 조건:

- [x] interval, notification, manual wakeup은 하나의 coordinator를 통한다.
- [x] 실행 중에는 poll 하나만 있고 추가 trigger는 최대 한 번의 queued rerun으로 coalesce한다.
- [x] 모든 background rejection을 catch해 logger/observer로 전달하되 scheduler가 종료되지 않는다.
- [x] transient DB failure 뒤 다음 trigger에서 정상 복구한다.
- [x] notification storm의 max concurrent poll이 1이고 memory가 trigger 수에 비례해 증가하지 않는다.
- [x] shutdown이 queued rerun을 시작하지 않고 in-flight poll만 정해진 계약으로 기다린다.

검증: 프로필 A/C. 비범위: 처리 callback의 병렬도 확대.

### `OUT-M04A` — at-least-once 전달 계약 긴급 정정

- 상태: `P0 / READY`
- 범위: 구현 변경 없이 현재 truth를 README와 package docs에 반영한다.

완료 조건:

- [ ] 절대적인 “동시에 두 번 처리되지 않는다” 문장을 제거한다.
- [ ] polling/local/publisher가 모두 at-least-once임을 명시한다.
- [ ] callback/broker ack 뒤 `SENT` 기록 전 crash, multi-handler partial success, 현재 stuck-row recovery/claim ownership race의 duplicate window를 설명한다.
- [ ] consumer는 `record.id` 또는 애플리케이션이 정의한 stable key로 멱등해야 함을 예제로 보인다.
- [ ] `idempotency_key`, `partition_key`, Outbox `SENT`의 정확한 의미와 FIFO 비보장을 명시한다.
- [ ] 기존 0.2 spec의 Draft/역사 상태와 현재 README 권위를 구분한다.

검증: 프로필 F. 비범위: M01–03 구현 완료를 거짓으로 서술하는 것.

### `OUT-M04B` — 실제 PostgreSQL 다중 poller와 crash-window release gate

- 상태: `P0 / BLOCKED`; 선행 `OUT-M01–03`

완료 조건:

- [ ] 두 app/poller가 같은 table을 처리하는 E2E가 있다.
- [ ] SKIP LOCKED initial claim, long callback heartbeat, expired lease recovery, stale completion CAS를 각각 검증한다.
- [ ] publisher accept 뒤 `SENT` write 전 process loss에서 duplicate 가능성과 eventual terminal state를 검증한다.
- [ ] notification burst와 polling fallback이 coordinator 한도를 지킨다.
- [ ] CI와 release가 이 fixture를 PostgreSQL service에서 실행한다.
- [ ] flake를 숨기는 arbitrary sleep 대신 barrier/clock/explicit polling을 사용한다.

검증: 프로필 B/C/E.

## 4. P1 작업 명세

### `OUT-M05` — retry due time 영속화

- 상태: `P1 / BLOCKED`; 선행 `OUT-M01`
- 문제: 각 process의 현재 backoff/initialDelay로 row eligibility를 다시 계산해 rolling config가 기존 실패의 재시도 시각을 바꾼다.

완료 조건:

- [ ] 실패 전이에서 `next_attempt_at`을 한 번 계산해 row에 저장한다.
- [ ] `next_attempt_at` column/index와 이 버전에서 필요한 fresh/upgrade SQL은 이 작업이 소유한다. `OUT-M19`는 통합 과거-version 경로를 검증한다.
- [ ] initial `NULL`은 즉시 eligible인 미실패 row만 뜻하고, 실패 due time은 DB clock을 기준으로 기록한다.
- [ ] claim query와 index가 stored due time을 사용한다.
- [ ] manual retry는 명시적으로 due now를 만들고 retry count/processedAt 불변식을 문서화한다.
- [ ] exponential overflow와 max delay 상한을 fail-closed 처리한다.
- [ ] 서로 다른 config의 poller가 같은 row due time에 합의한다.

검증: 프로필 A/B/C. `OUT-M19`는 이 작업의 schema를 포함한 v0.1/v0.2 통합 upgrade 경로를 검증한다.

### `OUT-M06` — tenant producer provenance 정책

- 상태: `P1 / DECISION`
- 문제: property presence만 override로 처리해 `{tenantId: undefined}`가 provider fallback을 막고 NULL을 저장한다. blank/null/provider mismatch 정책이 없다.

완료 조건:

- [ ] `optional`, `required`, `require-match` 또는 동등한 명시 정책을 ADR로 고정한다.
- [ ] undefined는 우발적 override가 아니며 provider fallback 계약을 따른다.
- [ ] blank/whitespace/invalid type은 DB mutation 전에 거부한다.
- [ ] explicit tenant와 trusted provider가 충돌하면 정책에 따라 fail-closed한다.
- [ ] global event는 우발적 null이 아닌 명시적 escape hatch로 표현한다.
- [ ] tenant ID를 trim/repair하지 않고 canonical producer value를 사용하거나 거부한다.

검증: 프로필 A/B/D. 비범위: `@nestarc/tenancy` hard dependency.

### `OUT-M07` — privileged operator API와 tenant-safe admin API

- 상태: `P1 / BLOCKED`; 선행 `OUT-M06`, `OUT-M08`

완료 조건:

- [ ] 기존 global admin API가 trusted control plane임을 이름/문서/타입으로 명확히 한다.
- [ ] tenant-facing read/mutation에는 expected tenant/scope predicate가 SQL에 반드시 들어간다.
- [ ] tenant A는 B의 payload, headers, error, stats를 조회하거나 retry/fail/purge할 수 없다.
- [ ] privileged API를 HTTP controller에 직접 노출하지 말라는 예제와 caller authorization 책임을 문서화한다.
- [ ] 패키지가 RBAC 구현을 import하지 않는다.

검증: 프로필 A/B/D.

### `OUT-M08` — admin 상태 전이 CAS

- 상태: `P1 / BLOCKED`; 선행 `OUT-M01–02`, `OUT-M05`

완료 조건:

- [ ] retry, markFailed, purge의 허용 source-state matrix가 있다.
- [ ] active claim은 owner/fencing 계약 없이 admin이 terminal로 덮지 않는다.
- [ ] poller와 admin race에서 terminal state가 역전되지 않는다.
- [ ] retry count, lastError, processedAt, nextAttemptAt 불변식을 operation별로 고정한다.
- [ ] 결과는 `applied | not_found | conflict | lost_claim` 또는 동등한 discriminated union으로 고정하고 stale/illegal mutation을 구분한다.

검증: 프로필 A/B/C.

### `OUT-M09` — LISTEN/NOTIFY degrade/reconnect lifecycle

- 상태: `P1 / BLOCKED`; 선행 `OUT-M03`

완료 조건:

- [ ] optional wakeup 초기 연결 실패는 polling으로 degrade하고 module boot를 막지 않는다.
- [ ] polling disabled + wakeup unavailable 조합은 stable typed init error로 fail-fast한다.
- [ ] generation guard로 stale client의 error/end가 새 reconnect를 만들지 않는다.
- [ ] client 교체 전에 transport가 지원하는 listener 제거와 `end()`를 수행하고, listener 제거 API가 없을 때도 generation guard가 stale callback을 무효화한다.
- [ ] connect/query/end/error/shutdown-race test가 있다.
- [ ] reconnect backoff와 observability가 있고 timer가 shutdown 뒤 남지 않는다.

검증: 프로필 A/B/C.

### `OUT-M10` — runtime option과 persisted invariant validation

- 상태: `P1 / READY`

완료 조건:

- [ ] interval, batch, retry count, initial delay, threshold, reconnect delay를 finite/safe integer/range로 검증한다.
- [ ] delivery mode, polling/wakeup/transport 조합을 module init에서 검증한다.
- [ ] invalid negative threshold가 active row를 회수할 수 없다.
- [ ] persisted status/retry/date/JSON 손상은 fail-closed하고 진단 가능한 오류를 낸다.
- [ ] 가능한 invariant는 additive DB CHECK와 runtime test 양쪽에 둔다.

검증: 프로필 A/B/D.

### `OUT-M11` — `forRootAsync` Nest DI와 option ownership

- 상태: `P1 / READY`

완료 조건:

- [ ] tenant provider class/transport는 bare `new`가 아니라 Nest DI가 생성한다.
- [ ] async factory가 뒤늦게 provider class를 반환하는 형태에 의존하지 않고, top-level provider/token registration이 Nest provider graph에 먼저 참여하게 한다.
- [ ] factory-returned option과 top-level registration option의 소유권을 타입으로 구분한다.
- [ ] `transport`, `isGlobal`, tenant provider의 실제 지원 형태가 README와 일치한다.
- [ ] constructor injection이 필요한 provider와 custom transport module test가 Nest 10/11에서 통과한다.
- [ ] unsupported async shape는 compile 또는 init에서 조용히 무시되지 않는다.

검증: 프로필 A/D. 공개 option shape가 깨지면 pre-1.0 minor로 낸다.

### `OUT-M12` — release authorization과 least privilege

- 상태: `P1 / READY`
- 문제: manual dispatch 기본값이 publish이고 tag/version check는 tag push에만 적용된다. publish와 GitHub Release 권한도 같은 job 경계에 있고 Actions가 mutable major tag다.

완료 조건:

- [ ] 실제 publish는 protected main의 immutable matching `v*` tag만 허용한다.
- [ ] manual dispatch는 dry-run only 또는 exact protected SHA/tag confirmation을 요구한다.
- [ ] actionlint 또는 repository-local workflow policy fixture로 manual publish 기본값, job-level permission, immutable action ref의 첫 RED를 자동 검증한다.
- [ ] npm publish job은 OIDC만, GitHub Release job은 contents write만 가져 서로의 고권한을 공유하지 않는다.
- [ ] verify jobs는 `contents: read`이며 write/OIDC가 없다.
- [ ] privileged third-party action과 official actions를 reviewed commit SHA로 pin한다.
- [ ] main/tag ruleset, required CI, force-push/tag 이동 차단, npm environment review/deployment policy를 관리자 설정에서 기록한다.
- [ ] 관리자 설정 변경 전 read-only before-state와 대상 repo/environment를 캡처하고 명시적 권한 범위 안에서만 변경한다.
- [ ] settings 작업이 별도 권한 때문에 남으면 같은 ID를 `EXTERNAL`로 인계하고 코드 부분만 DONE 처리하지 않는다.

검증: 프로필 E와 GitHub settings evidence.

### `OUT-M13` — Prisma 5 지원 증거 복구

- 상태: `P1 / READY`

완료 조건:

- [ ] peer의 Prisma 5 선언을 유지하려면 Node 22 + Nest 10.4.22 + Schedule 4 + exact Prisma 5.22.x의 generate/build/PostgreSQL packed-consumer lane을 둔다.
- [ ] 5/6/7에서 SQL asset와 public declarations를 같은 방식으로 소비한다.
- [ ] 유지할 수 없으면 다음 breaking release에서 range를 좁히고 README/CHANGELOG migration을 제공한다.
- [ ] 현재 6.19.3/7.10.0 lanes와 modern consumer는 그대로 보존한다.

검증: 프로필 B/D/E.

### `OUT-M14` — Node LTS와 Nest 12 지원 정책

- 상태: `P1 / DECISION`

완료 조건:

- [ ] Node 20 EOL 이후 지원 종료/legacy quarantine/다음 major 제거 중 하나를 ADR로 정한다.
- [ ] Node 22/24를 필수 control/runtime lane으로 검증한다.
- [ ] 현재 peer range로 strict install이 먼저 실패하는 것도 증거로 남기고, 임시 candidate manifest에서 exact Nest 12 + 해당 Schedule major + Prisma 대표 버전 type/module/PostgreSQL consumer를 실행한 뒤 최종 peer 결정을 채택한다.
- [ ] proof 전에는 peer range를 넓히지 않는다.
- [ ] engines/peers/README/CI/release가 같은 표를 사용한다.
- [ ] Node 26은 LTS 전 allowed-failure canary 이상으로 선언하지 않는다.

검증: 프로필 A/B/D/E.

### `OUT-M21` — pack-once와 exact artifact publish

- 상태: `P1 / BLOCKED`; 선행 `OUT-M12`
- verify job에서 tgz를 한 번 만들고 SRI/allowlist/size/root/types/SQL/consumer를 검사한다.
- publish job은 fresh checkout rebuild가 아니라 검증한 exact tgz를 다운로드해 publish한다.
- registry integrity와 attestation subject/ref/digest를 사후 검증한다.
- existing version rerun은 동일 bytes일 때만 idempotent success하고 다른 bytes면 fail한다.

## 5. P2 작업 명세

### `OUT-M15` — hook 불변성과 commit 의미

- `onEmit`은 caller transaction commit 전의 staged/attempted 관측임을 명시한다.
- `onDispatchStart` 등 observer는 delivery/state를 바꿀 수 없는 snapshot을 받는다.
- rollback된 emit, no-handler failure, hook throw/reject의 관측 의미를 표로 고정한다.
- durable compliance audit가 필요하면 같은 transaction의 audit row/별도 durable event를 사용하도록 안내한다.

### `OUT-M16` — envelope·JSON·bulk 입력 계약

- event/tenant/aggregate/partition/correlation/header 길이와 빈 값 정책을 정의한다.
- Invalid Date, BigInt, circular/non-plain JSON, oversized payload를 DB 호출 전에 stable error로 거부한다.
- `emitMany`는 PostgreSQL bind 한계 안에서 transaction-preserving chunk 또는 documented maximum을 사용한다.
- 같은 decorator 안의 duplicate event entry와 동일 `(instance, method, eventType)` 중복 discovery만 fail-fast한다. 서로 다른 handler의 의도된 동일 event fan-out은 보존한다.

### `OUT-M17` — ordering 비보장과 deterministic cursor

- UPDATE RETURNING/동일 transaction timestamp가 FIFO를 만들지 않는다고 문서화한다.
- SQL의 “per-aggregate ordering” 오해 주석을 수정한다.
- admin list는 `(created_at,id)`의 정렬 방향과 exclusive boundary를 고정하고 opaque versioned cursor와 `nextCursor`를 제공한다. 기존 Date filter의 호환 경로와 semver를 명시한다.
- strict aggregate/partition FIFO는 `OUT-B01`로 남긴다.

### `OUT-M18` — admin pagination, retention, bulk performance

- 선행: `OUT-M05`, `OUT-M07–08`, `OUT-M17`.
- stable cursor와 tenant predicate를 결합한다.
- `retryMany` bind-limit chunking과 partial failure 의미를 정한다.
- global stats/full-history count, purge/retention index는 `EXPLAIN ANALYZE` 증거 뒤 추가한다.
- payload/header/error의 보존 기간과 redaction 책임을 문서화한다.

### `OUT-M19` — schema upgrade와 diagnostic compatibility

- 선행: `OUT-M01–02`, `OUT-M05`, `OUT-M10`.
- fresh, v0.1→current, v0.2→current fixture DDL을 release tag/checksum과 함께 고정하고 실제 PostgreSQL로 검증한다.
- claim/lease/next-attempt column과 index/CHECK를 idempotent하게 적용한다.
- schema가 오래됐을 때 generic query error 대신 required/actual version 진단을 제공한다.
- package에 포함되는 SQL asset와 README 명령을 packed tarball에서 검증한다.

### `OUT-M20A` — publisher terminal과 tenant-context PostgreSQL E2E

- 선행: `OUT-M01`, `OUT-M05–06`, `OUT-M10`.
- 이미 있는 fresh migration·explicit tenant test를 중복하지 않고 publisher final `FAILED`, provider-derived tenant 저장, ambient context 복원을 실제 PostgreSQL에서 검증한다.
- shutdown 중 publisher callback 거부가 retriable Outbox 상태로 남는지는 dev-only fake transport로 검증한다.

### `OUT-M20B` — LISTEN/NOTIFY wakeup과 fallback PostgreSQL E2E

- 선행: `OUT-M03`, `OUT-M09`.
- LISTEN 준비 전/후 notification, burst coalescing, notification loss 뒤 polling fallback, reconnect 세대를 deterministic barrier로 검증한다.
- 임의 sleep 대신 readiness hook과 eventual assertion을 사용한다.

### `OUT-M20C` — shutdown/retry/upgrade 통합 PostgreSQL E2E

- 선행: `OUT-M02`, `OUT-M05`, `OUT-M19`.
- 미시작 claim shutdown 반납, 서로 다른 process config에서도 저장된 due time 사용, fresh/v0.1/v0.2 upgrade 뒤 runtime 처리를 통합 fixture로 검증한다.
- 실제 co-located Jobs lifecycle 조합은 `JOBS-M22`와 `TEN-ECO-NEXT`가 소유하며 Outbox에 Jobs runtime dependency를 추가하지 않는다.

### `OUT-M22` — dev dependency audit remediation

- production audit zero를 permanent gate로 유지한다.
- Prisma CLI/deepmerge/mysql, Jest/Babel, ESLint/brace-expansion/js-yaml 등 경로를 분리한다.
- Prisma 7 지원을 지우는 audit 자동 downgrade는 사용하지 않는다.
- 이 ID의 한 PR에서는 분류와 한 compatible dependency 묶음만 적용한다. 남은 도구 체인 묶음은 구현 전에 `OUT-M22B/C` 같은 별도 queue row로 추가한다.
- 남은 dev-only exception에는 owner/reason/expiry를 둔다.

### `OUT-M23` — explicit root와 SQL package export 계약

- 실제 public deep import 사용을 조사한 ADR을 먼저 작성한다.
- 채택 시 root와 필요한 두 SQL asset만 명시적으로 export하고 accidental internals는 차단한다.
- CJS/type resolution/SQL `require.resolve`/no-optional-pg packed consumers를 둔다.
- `exports`가 기존 deep import를 깨뜨리면 pre-1.0 minor와 migration note로 낸다.

### `OUT-M24` — 역사 문서와 현재 handover 정리

- old handover/spec/plan/SOLID report 상단에 `HISTORICAL`, `COMPLETED`, `SUPERSEDED`와 이 문서 링크를 둔다.
- 완료된 v0.2 항목을 unchecked backlog처럼 보이게 하지 않는다.
- 아직 유효한 poller SRP/typing 관찰만 현재 task ID로 연결하고 과거 작업 지시를 복사하지 않는다.

### `OUT-M25` — typechecked packed examples

- 선행: `OUT-M06`, `OUT-M11`, `OUT-M23`.
- local, publisher, tenant provider, SQL migration 예제를 source checkout이 아닌 tgz consumer에서 compile한다.
- Kafka 등 외부 broker snippet은 DI visibility와 provider registration을 실제 module fixture로 검증하거나 의사 코드라고 표시한다.
- optional `pg` 부재/존재 경계를 각각 검증한다.

### `OUT-M26` — critical coverage contract

- 선행: `OUT-M01–02`, `OUT-M08–09`, `OUT-M20A–C`.
- global 80%만 올리는 대신 poller state transitions, admin CAS, listener reconnect/fallback의 critical branch 목록을 정한다.
- DB/concurrency contract는 coverage 수치로 대체하지 않는다.
- CI artifact가 exact tested tuple과 commit을 나타내게 한다.

### `OUT-REL-01` — next release gate

- 상태: `release / BLOCKED`; 선행 `OUT-M01–03`, `OUT-M04A–B`, `OUT-M05`, `OUT-M09`, `OUT-M12–13`, `OUT-M19`, `OUT-M21`
- `OUT-M01–03`, `OUT-M04A–B`, `OUT-M05`의 semver 메모를 종합해 schema/public behavior에 맞는 next version을 결정하고 manifest/README/CHANGELOG를 맞춘다.
- `OUT-M12`의 authorization/least privilege, `OUT-M13`의 선언된 Prisma floor 증거, `OUT-M19`의 migration을 포함한 release commit에서 `OUT-M21`의 pack-once workflow를 실행한다.
- 모든 선행 작업이 merge된 release commit에서 프로필 A/B/C/D/E와 P0 regression을 검증한 candidate tgz를 한 번만 만들고 그 exact artifact만 publish한다. 이전 task branch에서 만든 tgz를 재사용하지 않는다.
- release commit이 fetched protected main에 포함되고 matching immutable tag가 같은 commit을 가리키는지 확인한다.
- npm integrity/provenance/attestation과 GitHub Release를 확인하고 candidate digest를 작업 기록에 남긴다.
- Jobs publish나 `TEN-ECO-NEXT`를 Outbox package release 선행 조건으로 만들지 않는다.

## 6. P3와 P4

### P3 유지보수

- `OUT-M27`: disposable loopback PostgreSQL guard 아래 Prisma 7 adapter로 benchmark를 다시 compile/run하고 공용 SQL parser, exact `bench`/`bench:smoke` 명령, Node/PostgreSQL/fixture cardinality가 포함된 재현 가능한 baseline을 둔다.
- `OUT-M28`: unusable external `.js.map`/`.d.ts.map`을 `inlineSources`, shipped source, maps 제거 중 하나로 결정하고 tarball assertion을 둔다.
- `OUT-M29`: `SECURITY.md`, supported release policy, private report path, PostgreSQL baseline, release recovery, lease/backlog/FAILED/retention runbook을 작성한다.
- `OUT-M30`: package/CI/release/consumer script의 exact version을 compatibility manifest 또는 drift assertion으로 동기화한다.
- `OUT-M31`: `OUT-M01–11` 완료와 해당 contract test 고정 뒤 poll coordinator, claim store, dispatcher를 내부 단위로 분리한다. public generic queue abstraction은 만들지 않는다.

### P4 연구 후보

| ID        | 후보                                         | 승격 전 필수 산출물                                            |
| --------- | -------------------------------------------- | -------------------------------------------------------------- |
| `OUT-B01` | aggregate/partition strict FIFO              | locking/throughput/starvation ADR와 PG benchmark               |
| `OUT-B02` | scoped producer deduplicated insert          | `(tenant,eventType,key)` scope, null, retention, migration ADR |
| `OUT-B03` | inbox/consumer dedupe helper                 | consumer transaction boundary와 storage ownership 설계         |
| `OUT-B04` | schema version/validator/upcaster            | backward/forward compatibility 정책                            |
| `OUT-B05` | Kafka/RabbitMQ/NATS/SQS first-party adapters | ack/retry/idempotency conformance suite                        |
| `OUT-B06` | OpenTelemetry adapter                        | semantic convention과 cardinality budget                       |
| `OUT-B07` | partition/archive/dashboard                  | retention/SLO/operational ownership                            |
| `OUT-B08` | logical replication/CDC                      | polling과의 coexistence/failover spike                         |
| `OUT-B09` | Prisma 8, multi-ORM, dual ESM/CJS            | stable upstream release와 isolated consumer evidence           |

P4는 현재 release의 acceptance가 아니다. fan-out도 adapter 내부 반복 publish로 바로 구현하지 않는다. 부분 성공 후 retry 의미를 별도 record 또는 saga로 먼저 설계해야 한다.

## 7. 검증 프로필

### 프로필 A — 빠른 source 계약

```bash
export OUTBOX_START_REF="$(git rev-parse origin/main)"
npm ci
npm run clean
npm test -- --runInBand
npm run lint
npx --no-install tsc --noEmit -p tsconfig.build.json
npm run build
git diff --check "$OUTBOX_START_REF"...HEAD
git diff --check
git diff --cached --check
git status --short
```

전용 worktree에서 실행하고 `git status --short`의 모든 파일을 설명한다. untracked file은 `git diff --check`에 잡히지 않으므로 formatter/checker를 path에 직접 실행한 뒤 path-scoped `git add`만 사용한다. `git add -A`는 사용하지 않는다.

### 프로필 B — PostgreSQL

이 suite는 `outbox_events`를 `TRUNCATE`/`DROP`한다. 상속된 `DATABASE_URL`이나 공유 DB에서 실행하지 않는다. compose file은 고정 host port `5433`을 쓰므로 DB 프로필은 한 번에 한 세션만 실행하고, 포트가 사용 중이면 소유자를 확인하기 전 시작·종료하지 않는다.

```bash
export OUTBOX_COMPOSE_PROJECT=outbox-out-mxx-unique
lsof -nP -iTCP:5433 -sTCP:LISTEN || true
docker compose -p "$OUTBOX_COMPOSE_PROJECT" up -d --wait
export DATABASE_URL=postgresql://test:test@127.0.0.1:5433/outbox_test
npm run test:e2e
npm run test:modern-consumer
```

`lsof` 결과에 모르는 process가 있으면 중단한다. 세션이 직접 시작한 정확한 compose project만 종료한다.

```bash
docker compose -p "$OUTBOX_COMPOSE_PROJECT" down
```

### 프로필 C — 상태 경쟁/장애

- two pollers + barrier-controlled slow callback
- stale token `SENT/PENDING/FAILED` 0-row CAS
- lease heartbeat/expiry와 process-loss recovery
- timer+notification storm max concurrency
- transient DB failure 뒤 recovery
- shutdown/reconnect race

arbitrary sleep 대신 barrier, fake clock, explicit eventual assertion을 사용한다.

### 프로필 D — packed consumer

```bash
npm run clean
npm run build
npm pack --dry-run
export OUTBOX_PACK_DIR="$(mktemp -d)"
npm pack --pack-destination "$OUTBOX_PACK_DIR"
export OUTBOX_TGZ="$(find "$OUTBOX_PACK_DIR" -maxdepth 1 -name 'nestarc-outbox-*.tgz' -print -quit)"
test -n "$OUTBOX_TGZ"
shasum -a 256 "$OUTBOX_TGZ"
```

해당 task의 Nest/Prisma/optional-peer strict consumer는 위 `OUTBOX_TGZ`와 digest를 그대로 받아 깨끗한 임시 프로젝트에서 설치·typecheck·실행한다.

### 프로필 E — release/security

```bash
npm run test:cov
npm audit --omit=dev
npm audit
```

`npm audit --omit=dev`는 hard zero gate다. 전체 `npm audit`는 `OUT-M22` 완료 전까지 결과와 승인된 dev-only 예외를 기록하는 evidence이며 일반 P0/P1의 자동 hard-fail 조건이 아니다. 여기에 exact tgz digest, allowlist, registry integrity/attestation, workflow permissions, tag/main ancestry, GitHub ruleset/npm environment 증거를 추가한다.

### 프로필 F — 문서

- package manifest, README, CHANGELOG, SQL asset, release 사실을 서로 대조한다.
- code link와 명령은 현재 tree에서 실제로 존재하고 실행 가능한지 확인한다.
- 역사 문서를 새 backlog로 해석할 여지를 제거한다.

## 8. 교차 패키지와 release 순서

소유권은 다음처럼 유지한다.

```text
Outbox ── durable record / publisher callback ──> Jobs adapter ──> Jobs backend/worker
   │                                                  │
   └ claim·lease·retry·SENT/FAILED 소유                └ job identity·dedupe·execution 소유
```

- Outbox는 Jobs를 runtime dependency로 추가하지 않는다.
- claim token은 Jobs structural `OutboxRecord`에 노출하지 않는다.
- Jobs의 stable record ID dedupe가 Outbox claim race를 해결한다고 간주하지 않는다.
- 구현은 병렬 가능하다. 각 패키지는 자체 source/DB/Redis/packed candidate 증거로 `DONE` 처리한다.
- 권장 publish 순서: Outbox patch/minor → Jobs가 exact published Outbox 또는 candidate tgz로 consumer 검증 → Jobs patch/minor.
- `TEN-ECO-NEXT`는 두 패키지 게시 뒤 실제 PostgreSQL + Redis/BullMQ에서 commit/rollback, ack-before-SENT crash, restart dedupe, tenant A/B 격리, lineage를 검증한다.
- 이 외부 chaos fixture는 loopback-only disposable DB/Redis, unique compose project/database/namespace를 사용한다. 세션이 spawn해 PID를 기록한 process만 kill하고 shared service를 drop/flush/restart하지 않으며 자신이 만든 resource만 정리한다.
- `TEN-ECO-NEXT`는 사후 외부 증거다. Outbox/Jobs package task의 `DONE`을 다시 그 결과에 순환 의존시키지 않는다.

## 9. 작업 기록

| 날짜       | Task        | 상태   | ref/PR                                       | 검증 결과                                                                                 | 다음 정확한 행동                                                       |
| ---------- | ----------- | ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 2026-09-02 | 계획 기준선 | `DONE` | `origin/main@873f95b` 조사                   | unit 88, lint/typecheck/coverage/audit 기록; fresh DB E2E 미실행                          | `OUT-PLAN-01`로 이 문서만 먼저 review/merge                            |
| 2026-09-03 | `OUT-M01`   | `DONE` | `codex/out-m01-fenced-claims` working tree   | unit 95, lint/typecheck/build PASS; PostgreSQL E2E 13 PASS; packed Prisma 7 consumer PASS | 변경 review 후 branch를 commit/push하고 `OUT-M04A` 또는 `OUT-M03` 진행 |
| 2026-09-03 | `OUT-M03`   | `DONE` | `901865c`                                    | unit 100, lint/typecheck/clean build PASS; timer/notification burst/shutdown race PASS    | local main merge `ad96d8e`에서 `OUT-M02` 진행                          |
| 2026-09-03 | `OUT-M02`   | `DONE` | `codex/out-m02-lease-heartbeat` working tree | unit 110, PostgreSQL E2E 16, packed Prisma 7 consumer, coverage/lint/typecheck/build PASS | 변경 review 후 branch를 commit/push/merge하고 `OUT-M04A` 진행          |

### `OUT-M01` 종료 인계

```text
Task: OUT-M01
State: DONE
Start ref / end ref: origin/main@873f95bd86682d4b9515d743efbcfc093a88f450 / codex/out-m01-fenced-claims working tree (uncommitted)
Changed files: poller claim/CAS, readonly callback interfaces, local snapshots, fresh/upgrade SQL, unit/PostgreSQL contract tests, README, CHANGELOG, ADR
Contract / semver decision: claim_token은 private internal field다. callback은 deep detached snapshot과 readonly type을 받지만 runtime freeze는 보장하지 않는다. 필수 additive migration과 public readonly type tightening 때문에 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: 첫 RED poller test 1 FAIL/20 PASS; npm ci 649 packages; unit 9 suites/95 tests PASS; lint PASS; build typecheck/build PASS; PostgreSQL E2E 13 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS; git diff --check PASS
Unverified paths and reason: 없음. OUT-M01 범위의 profile A/B/C를 실행했다.
External PR, run, release evidence: 없음. branch-local working tree이며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: exactly-once와 lease/heartbeat/stuck recovery는 보장하지 않는다. OUT-M02와 OUT-M04B 범위다.
Next exact action: diff를 review한 뒤 OUT-M01 파일만 commit/push/PR하고, 독립 P0인 OUT-M04A 또는 OUT-M03을 origin/main 기준 새 branch에서 진행한다.
```

### `OUT-M03` 종료 인계

```text
Task: OUT-M03
State: DONE
Start ref / end ref: local main@012e8d6349fd2a099e1169529a2006b94c99c00c / 901865c96fcbc30c042283a0f6a6b4a9e1007675
Changed files: poll single-flight coordinator와 timer 오류 격리, timer/notification burst/transient failure/shutdown contract tests, CHANGELOG, maintenance plan
Contract / semver decision: public option/type 변화 없이 poll scheduling 내부 동작만 안전하게 제한한다. concurrent trigger는 active poll 하나와 queued rerun 하나로 coalesce하며 manual poll은 poll 오류를 계속 reject한다. patch-compatible fix다.
Commands and exact results: 첫 RED poller test 4 FAIL/26 PASS; npm ci 649 packages; focused poller/listener 2 suites/43 tests PASS; full unit 9 suites/100 tests PASS; lint PASS; build typecheck PASS; clean build PASS; git diff --check PASS
Unverified paths and reason: 없음. OUT-M03 범위의 profile A/C를 실행했으며 PostgreSQL schema/state machine 변경은 없다.
External PR, run, release evidence: local commit 901865c와 local main merge ad96d8e. push/PR/release는 수행하지 않았다.
Remaining risk: lease/heartbeat/stuck recovery는 OUT-M02, LISTEN/NOTIFY 연결 실패와 reconnect lifecycle은 OUT-M09 범위다.
Next exact action: 완료. local main merge ad96d8e에서 OUT-M02를 시작했다.
```

### `OUT-M02` 종료 인계

```text
Task: OUT-M02
State: DONE
Start ref / end ref: local main@ad96d8e / codex/out-m02-lease-heartbeat working tree (uncommitted)
Changed files: claim-on-demand poller, active lease heartbeat와 expired recovery/shutdown release, lease options/export, fresh/upgrade SQL, unit/PostgreSQL tests, README/CHANGELOG, ADR 0002, maintenance plan
Contract / semver decision: lease.duration은 명시값이 deprecated stuckThreshold alias보다 우선한다. heartbeatInterval은 duration/2 미만이며 기본 duration/3, heartbeatFailureTolerance 기본 1이다. recovery는 retry budget을 소비하지 않는다. live heartbeat가 유지되는 영구 callback hang은 자동 회수하지 않고 application timeout/process termination이 필요하다. 0.2.x poller는 heartbeat를 쓰지 않으므로 lease-aware runtime 시작 전에 drain해야 한다. additive public option/schema migration이므로 기존 OUT-M01과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 PostgreSQL RED max concurrent callback 2로 FAIL; npm ci 649 packages; unit 9 suites/110 tests PASS; PostgreSQL E2E 16 PASS; final packed 첫 시도는 정리된 DB 때문에 connection FAIL, 격리 DB 재시작 뒤 Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS (sha512-9hWoNp4lFr5t4NBgoSkkRp4Mp2aVrXOkXScMiAHnT7ObOawOuKh5mH4iA6OD4UMZKLuGbXEx1LXmbIS7wKRnfw==); coverage statements 95.33%, branches 84.81%, functions 99.05%, lines 96.06%; lint/typecheck/build PASS; production audit 0; full audit 10 dev-only (high 7, moderate 1, low 2); git diff --check PASS
Unverified paths and reason: 없음. OUT-M02 범위의 profile B/C/E와 packed consumer를 실행했다.
External PR, run, release evidence: 없음. branch-local working tree이며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: heartbeat loss 뒤 이미 시작된 외부 side effect는 취소할 수 없어 at-least-once/idempotency가 필요하다. live heartbeat가 유지되는 영구 hang은 운영 timeout/termination이 필요하다. 실제 crash-window release gate는 OUT-M04B 범위다.
Next exact action: diff를 review한 뒤 OUT-M02 파일만 commit/push/merge하고, 다음 최저 미완료 P0인 OUT-M04A를 진행한다.
```
