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

| 축         | 공개 선언                               | 현재 자동 증거                        | 유지보수 결론                                                                |
| ---------- | --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Node       | `>=22`                                  | CI/release Node 22/24; Node 26 canary | Node 20은 EOL로 제거했고 22/24만 필수 지원한다 (`OUT-M14`).                  |
| NestJS     | 10/11/12                                | exact 10.4.22, 11.2.3, 12.0.1         | Nest 12 strict packed PostgreSQL 증거를 Node 22/24에서 유지한다.             |
| Schedule   | 4/5/12                                  | Nest 10×4, Nest 11×5, Nest 12×12      | exact Schedule 12.0.1을 Nest 12 control에 고정한다.                          |
| Prisma     | 5/6/7                                   | exact 5.22.0, 6.19.3, 7.10.0          | 세 major의 strict packed PostgreSQL consumer와 CI/release lane을 유지한다.   |
| PostgreSQL | transactional SQL implementation        | PostgreSQL 16 CI/release              | 최소 지원 버전은 운영 문서에서 명시하고 migration 경로를 실제 DB로 검증한다. |
| package    | CommonJS root + deep-resolved SQL files | legacy/modern packed consumers        | 명시적 `exports` 여부는 `OUT-M23`에서 ADR 후 결정한다.                       |

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
|    1 | `OUT-M04A`     | P0       | `DONE`     | S    | 없음                                                                                 | at-least-once 전달 계약 긴급 정정                                   |
|    2 | `OUT-M01`      | P0       | `DONE`     | L    | 없음                                                                                 | 불변 claim identity와 fenced 상태 전이                              |
|    3 | `OUT-M02`      | P0       | `DONE`     | L    | `OUT-M01`, `OUT-M03`                                                                 | lease/heartbeat/recovery와 미시작 claim 반납                        |
|    4 | `OUT-M03`      | P0       | `DONE`     | M    | 없음                                                                                 | poll single-flight, coalescing, background 오류 격리                |
|    5 | `OUT-M04B`     | P0       | `DONE`     | L    | `OUT-M01–03`                                                                         | 실제 PostgreSQL 다중 poller/crash-window gate                       |
|    6 | `OUT-M05`      | P1       | `DONE`     | M    | `OUT-M01`                                                                            | `next_attempt_at` 기반 영속 retry 시각                              |
|    7 | `OUT-M06`      | P1       | `DONE`     | M    | 없음                                                                                 | tenant producer provenance 정책                                     |
|    8 | `OUT-M07`      | P1       | `DONE`     | M    | `OUT-M06`, `OUT-M08`                                                                 | privileged/tenant-safe admin 경계                                   |
|    9 | `OUT-M08`      | P1       | `DONE`     | M    | `OUT-M01–02`, `OUT-M05`                                                              | admin 상태 전이 CAS                                                 |
|   10 | `OUT-M09`      | P1       | `DONE`     | M    | `OUT-M03`                                                                            | LISTEN/NOTIFY degrade/reconnect lifecycle                           |
|   11 | `OUT-M10`      | P1       | `DONE`     | M    | 없음                                                                                 | runtime option/state invariant validation                           |
|   12 | `OUT-M11`      | P1       | `DONE`     | M    | 없음                                                                                 | `forRootAsync` DI와 async option 계약                               |
|   13 | `OUT-M12`      | P1       | `EXTERNAL` | M    | GitHub repository/environment 관리자 인증                                            | release authorization, least privilege, immutable actions           |
|   14 | `OUT-M13`      | P1       | `DONE`     | M    | 없음                                                                                 | Prisma 5 지원 선언 증거 복구                                        |
|   15 | `OUT-M14`      | P1       | `DONE`     | M    | 없음                                                                                 | Node LTS/Nest 12 현재 지원 정책                                     |
|   16 | `OUT-M21`      | P1       | `BLOCKED`  | M    | `OUT-M12`                                                                            | pack-once, exact artifact publish/provenance                        |
|   17 | `OUT-M15`      | P2       | `DONE`     | S    | `OUT-M01`                                                                            | hook의 불변성·commit 의미 문서화                                    |
|   18 | `OUT-M16`      | P2       | `DONE`     | M    | 없음                                                                                 | envelope·JSON·bulk 입력 계약                                        |
|   19 | `OUT-M17`      | P2       | `DONE`     | S    | 없음                                                                                 | ordering 비보장과 deterministic cursor 계약                         |
|   20 | `OUT-M18`      | P2       | `DONE`     | M    | `OUT-M05`, `OUT-M07–08`, `OUT-M17`                                                   | admin pagination/retention/bulk 성능                                |
|   21 | `OUT-M19`      | P2       | `DONE`     | L    | `OUT-M01–02`, `OUT-M05`, `OUT-M10`                                                   | schema upgrade/diagnostic compatibility                             |
|  22A | `OUT-M20A`     | P2       | `DONE`     | M    | `OUT-M01`, `OUT-M05–06`, `OUT-M10`                                                   | publisher terminal/tenant-context PostgreSQL E2E                    |
|  22B | `OUT-M20B`     | P2       | `DONE`     | M    | `OUT-M03`, `OUT-M09`                                                                 | LISTEN/NOTIFY wakeup/fallback PostgreSQL E2E                        |
|  22C | `OUT-M20C`     | P2       | `DONE`     | M    | `OUT-M02`, `OUT-M05`, `OUT-M19`                                                      | shutdown/retry/upgrade 통합 PostgreSQL E2E                          |
|   23 | `OUT-M22`      | P2       | `DONE`     | M    | 없음                                                                                 | dev dependency audit remediation                                    |
|   24 | `OUT-M23`      | P2       | `DONE`     | M    | 없음                                                                                 | explicit root/SQL package export 계약                               |
|   25 | `OUT-M24`      | P2       | `DONE`     | S    | 없음                                                                                 | 과거 문서 권위와 현재 handover 정리                                 |
|  25A | `OUT-M22B`     | P2       | `BLOCKED`  | M    | `OUT-M22`                                                                            | Prisma CLI dev advisory 후속                                        |
|  25B | `OUT-M22C`     | P2       | `DONE`     | M    | `OUT-M22`                                                                            | Jest/Nest dev advisory 후속                                         |
|   26 | `OUT-M25`      | P2       | `READY`    | M    | `OUT-M06`, `OUT-M11`, `OUT-M23`                                                      | typechecked packed examples                                         |
|   27 | `OUT-M26`      | P2       | `READY`    | S    | `OUT-M01–02`, `OUT-M08–09`, `OUT-M20A–C`                                             | critical branch coverage gate                                       |
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
| `OUT-M14`  | engines/peers/matrix/README                               | Node 22/24 × exact Nest 12.0.1/Schedule 12.0.1 strict consumer 결과를 ADR에 기록했다.                                                                      |
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

- 상태: `P0 / DONE`
- 범위: 구현 변경 없이 현재 truth를 README와 package docs에 반영한다.

완료 조건:

- [x] 절대적인 “동시에 두 번 처리되지 않는다” 문장을 제거한다.
- [x] polling/local/publisher가 모두 at-least-once임을 명시한다.
- [x] callback/broker ack 뒤 `SENT` 기록 전 crash, multi-handler partial success, lease/heartbeat loss와 stale completion의 duplicate window를 설명한다.
- [x] consumer는 `record.id` 또는 애플리케이션이 정의한 stable key로 멱등해야 함을 예제로 보인다.
- [x] `idempotency_key`, `partition_key`, Outbox `SENT`의 정확한 의미와 FIFO 비보장을 명시한다.
- [x] 기존 0.2 spec의 Draft/역사 상태와 현재 README 권위를 구분한다.

검증: 프로필 F. 비범위: M01–03 구현 완료를 거짓으로 서술하는 것.

### `OUT-M04B` — 실제 PostgreSQL 다중 poller와 crash-window release gate

- 상태: `P0 / DONE`; 선행 `OUT-M01–03`

완료 조건:

- [x] 두 app/poller가 같은 table을 처리하는 E2E가 있다.
- [x] SKIP LOCKED initial claim, long callback heartbeat, expired lease recovery, stale completion CAS를 각각 검증한다.
- [x] publisher accept 뒤 `SENT` write 전 process loss에서 duplicate 가능성과 eventual terminal state를 검증한다.
- [x] notification burst와 polling fallback이 coordinator 한도를 지킨다.
- [x] CI와 release가 이 fixture를 PostgreSQL service에서 실행한다.
- [x] flake를 숨기는 arbitrary sleep 대신 barrier/clock/explicit polling을 사용한다.

검증: 프로필 B/C/E.

## 4. P1 작업 명세

### `OUT-M05` — retry due time 영속화

- 상태: `P1 / DONE`; 선행 `OUT-M01`
- 문제: 각 process의 현재 backoff/initialDelay로 row eligibility를 다시 계산해 rolling config가 기존 실패의 재시도 시각을 바꾼다.

완료 조건:

- [x] 실패 전이에서 `next_attempt_at`을 한 번 계산해 row에 저장한다.
- [x] `next_attempt_at` column/index와 이 버전에서 필요한 fresh/upgrade SQL은 이 작업이 소유한다. `OUT-M19`는 통합 과거-version 경로를 검증한다.
- [x] initial `NULL`은 즉시 eligible인 미실패 row만 뜻하고, 실패 due time은 DB clock을 기준으로 기록한다.
- [x] claim query와 index가 stored due time을 사용한다.
- [x] manual retry는 명시적으로 due now를 만들고 retry count/processedAt 불변식을 문서화한다.
- [x] exponential overflow와 max delay 상한을 fail-closed 처리한다.
- [x] 서로 다른 config의 poller가 같은 row due time에 합의한다.

검증: 프로필 A/B/C. `OUT-M19`는 이 작업의 schema를 포함한 v0.1/v0.2 통합 upgrade 경로를 검증한다.

### `OUT-M06` — tenant producer provenance 정책

- 상태: `P1 / DONE`
- 문제: property presence만 override로 처리해 `{tenantId: undefined}`가 provider fallback을 막고 NULL을 저장한다. blank/null/provider mismatch 정책이 없다.

완료 조건:

- [x] `optional`, `required`, `require-match` 또는 동등한 명시 정책을 ADR로 고정한다.
- [x] undefined는 우발적 override가 아니며 provider fallback 계약을 따른다.
- [x] blank/whitespace/invalid type은 DB mutation 전에 거부한다.
- [x] explicit tenant와 trusted provider가 충돌하면 정책에 따라 fail-closed한다.
- [x] global event는 우발적 null이 아닌 명시적 escape hatch로 표현한다.
- [x] tenant ID를 trim/repair하지 않고 canonical producer value를 사용하거나 거부한다.

검증: 프로필 A/B/D. 비범위: `@nestarc/tenancy` hard dependency.

### `OUT-M07` — privileged operator API와 tenant-safe admin API

- 상태: `P1 / DONE`; 선행 `OUT-M06`, `OUT-M08`

완료 조건:

- [x] 기존 global admin API가 trusted control plane임을 이름/문서/타입으로 명확히 한다.
- [x] tenant-facing read/mutation에는 expected tenant/scope predicate가 SQL에 반드시 들어간다.
- [x] tenant A는 B의 payload, headers, error, stats를 조회하거나 retry/fail/purge할 수 없다.
- [x] privileged API를 HTTP controller에 직접 노출하지 말라는 예제와 caller authorization 책임을 문서화한다.
- [x] 패키지가 RBAC 구현을 import하지 않는다.

검증: 프로필 A/B/D.

### `OUT-M08` — admin 상태 전이 CAS

- 상태: `P1 / DONE`; 선행 `OUT-M01–02`, `OUT-M05`

완료 조건:

- [x] retry, markFailed, purge의 허용 source-state matrix가 있다.
- [x] active claim은 owner/fencing 계약 없이 admin이 terminal로 덮지 않는다.
- [x] poller와 admin race에서 terminal state가 역전되지 않는다.
- [x] retry count, lastError, processedAt, nextAttemptAt 불변식을 operation별로 고정한다.
- [x] 결과는 `applied | not_found | conflict | lost_claim` 또는 동등한 discriminated union으로 고정하고 stale/illegal mutation을 구분한다.

검증: 프로필 A/B/C.

### `OUT-M09` — LISTEN/NOTIFY degrade/reconnect lifecycle

- 상태: `P1 / DONE`; 선행 `OUT-M03`

완료 조건:

- [x] optional wakeup 초기 연결 실패는 polling으로 degrade하고 module boot를 막지 않는다.
- [x] polling disabled + wakeup unavailable 조합은 stable typed init error로 fail-fast한다.
- [x] generation guard로 stale client의 error/end가 새 reconnect를 만들지 않는다.
- [x] client 교체 전에 transport가 지원하는 listener 제거와 `end()`를 수행하고, listener 제거 API가 없을 때도 generation guard가 stale callback을 무효화한다.
- [x] connect/query/end/error/shutdown-race test가 있다.
- [x] reconnect backoff와 observability가 있고 timer가 shutdown 뒤 남지 않는다.

검증: 프로필 A/B/C.

### `OUT-M10` — runtime option과 persisted invariant validation

- 상태: `P1 / DONE`

완료 조건:

- [x] interval, batch, retry count, initial delay, threshold, reconnect delay를 finite/safe integer/range로 검증한다.
- [x] delivery mode, polling/wakeup/transport 조합을 module init에서 검증한다.
- [x] invalid negative threshold가 active row를 회수할 수 없다.
- [x] persisted status/retry/date/JSON 손상은 fail-closed하고 진단 가능한 오류를 낸다.
- [x] 가능한 invariant는 additive DB CHECK와 runtime test 양쪽에 둔다.

검증: 프로필 A/B/D.

### `OUT-M11` — `forRootAsync` Nest DI와 option ownership

- 상태: `P1 / DONE`

완료 조건:

- [x] tenant provider class/transport는 bare `new`가 아니라 Nest DI가 생성한다.
- [x] async factory가 뒤늦게 provider class를 반환하는 형태에 의존하지 않고, top-level provider/token registration이 Nest provider graph에 먼저 참여하게 한다.
- [x] factory-returned option과 top-level registration option의 소유권을 타입으로 구분한다.
- [x] `transport`, `isGlobal`, tenant provider의 실제 지원 형태가 README와 일치한다.
- [x] constructor injection이 필요한 provider와 custom transport module test가 Nest 10/11에서 통과한다.
- [x] unsupported async shape는 compile 또는 init에서 조용히 무시되지 않는다.

검증: 프로필 A/D. 공개 option shape가 깨지면 pre-1.0 minor로 낸다.

### `OUT-M12` — release authorization과 least privilege

- 상태: `P1 / EXTERNAL` — repository workflow 변경은 완료됐으나 GitHub ruleset/npm environment 변경에 필요한 관리자 인증이 없다.
- 문제: manual dispatch 기본값이 publish이고 tag/version check는 tag push에만 적용된다. publish와 GitHub Release 권한도 같은 job 경계에 있고 Actions가 mutable major tag다.

완료 조건:

- [ ] 실제 publish는 protected main의 immutable matching `v*` tag만 허용한다. (workflow의 tag/version/main ancestry 검증은 완료; main/tag immutability ruleset은 외부 관리자 작업)
- [x] manual dispatch는 dry-run only 또는 exact protected SHA/tag confirmation을 요구한다.
- [x] actionlint 또는 repository-local workflow policy fixture로 manual publish 기본값, job-level permission, immutable action ref의 첫 RED를 자동 검증한다.
- [x] npm publish job은 OIDC만, GitHub Release job은 contents write만 가져 서로의 고권한을 공유하지 않는다.
- [x] verify jobs는 `contents: read`이며 write/OIDC가 없다.
- [x] privileged third-party action과 official actions를 reviewed commit SHA로 pin한다.
- [ ] main/tag ruleset, required CI, force-push/tag 이동 차단, npm environment review/deployment policy를 관리자 설정에서 기록한다.
- [x] 관리자 설정 변경 전 read-only before-state와 대상 repo/environment를 캡처하고 명시적 권한 범위 안에서만 변경한다.
- [x] settings 작업이 별도 권한 때문에 남으면 같은 ID를 `EXTERNAL`로 인계하고 코드 부분만 DONE 처리하지 않는다.

검증: 프로필 E와 GitHub settings evidence.

### `OUT-M13` — Prisma 5 지원 증거 복구

- 상태: `P1 / DONE`

완료 조건:

- [x] peer의 Prisma 5 선언을 유지하려면 Node 22 + Nest 10.4.22 + Schedule 4 + exact Prisma 5.22.x의 generate/build/PostgreSQL packed-consumer lane을 둔다.
- [x] 5/6/7에서 SQL asset와 public declarations를 같은 방식으로 소비한다.
- [x] 유지할 수 없으면 다음 breaking release에서 range를 좁히고 README/CHANGELOG migration을 제공한다. (해당 없음: exact 5.22.0 검증 통과)
- [x] 현재 6.19.3/7.10.0 lanes와 modern consumer는 그대로 보존한다.

검증: 프로필 B/D/E.

### `OUT-M14` — Node LTS와 Nest 12 지원 정책

- 상태: `P1 / DONE`

완료 조건:

- [x] Node 20 EOL 이후 지원 종료/legacy quarantine/다음 major 제거 중 하나를 ADR로 정한다.
- [x] Node 22/24를 필수 control/runtime lane으로 검증한다.
- [x] 현재 peer range로 strict install이 먼저 실패하는 것도 증거로 남기고, 임시 candidate manifest에서 exact Nest 12 + 해당 Schedule major + Prisma 대표 버전 type/module/PostgreSQL consumer를 실행한 뒤 최종 peer 결정을 채택한다.
- [x] proof 전에는 peer range를 넓히지 않는다.
- [x] engines/peers/README/CI/release가 같은 표를 사용한다.
- [x] Node 26은 LTS 전 allowed-failure canary 이상으로 선언하지 않는다.

검증: 프로필 A/B/D/E.

### `OUT-M21` — pack-once와 exact artifact publish

- 상태: `P1 / BLOCKED`; 로컬 구현·PostgreSQL consumer 검증 완료, 선행 `OUT-M12`와 remote tag/publish 증거 대기
- [x] build-and-test job에서 tgz를 한 번 만들고 SRI/SHA-256/allowlist/size/root/types/SQL을 검사한 뒤 모든 Node 22 consumer가 같은 tgz를 사용한다.
- [x] Node 24, manual dry-run, publish job은 rebuild/repack하지 않고 검증한 exact tgz와 metadata를 다운로드해 사용한다.
- [x] publish 전 registry integrity를 비교하고 existing version은 동일 bytes일 때만 idempotent skip하며 다른 bytes면 fail한다.
- [x] publish 뒤 npm signature와 verified publish/provenance statement에서 subject digest, repository, tag ref, source commit, workflow를 검사한 뒤에만 GitHub Release를 만든다.
- [x] repository-local workflow policy test와 artifact graph/evidence report를 추가했다.
- [ ] `OUT-M12` 보호 설정 뒤 manual remote run, 실제 next tag publish/attestation, immutable tag rerun 증거를 기록한다.

구현·로컬 증거: `docs/reports/2026-09-03-out-m21-pack-once.md`.

## 5. P2 작업 명세

### `OUT-M15` — hook 불변성과 commit 의미

- 상태: `P2 / DONE`
- [x] `onEmit`은 caller transaction commit 전의 staged/attempted 관측임을 명시한다.
- [x] `onDispatchStart` 등 observer는 delivery/state를 바꿀 수 없는 snapshot을 받는다.
- [x] rollback된 emit, no-handler failure, hook throw/reject의 관측 의미를 표로 고정한다.
- [x] durable compliance audit가 필요하면 같은 transaction의 audit row/별도 durable event를 사용하도록 안내한다.

검증: 프로필 A/D/F. readonly hook type과 detached snapshot은 additive/tightening 변화이므로 누적 작업과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.

### `OUT-M16` — envelope·JSON·bulk 입력 계약

- 상태: `P2 / DONE`
- [x] event/tenant/aggregate/partition/correlation/header 길이와 빈 값 정책을 정의한다.
- [x] Invalid Date, BigInt, circular/non-plain JSON, oversized payload를 DB 호출 전에 stable error로 거부한다.
- [x] `emitMany`는 PostgreSQL bind 한계 안에서 transaction-preserving chunk 또는 documented maximum을 사용한다.
- [x] 같은 decorator 안의 duplicate event entry와 동일 `(instance, method, eventType)` 중복 discovery만 fail-fast한다. 서로 다른 handler의 의도된 동일 event fan-out은 보존한다.

검증: 프로필 A/B/D/F. `OutboxEnvelopeError(OUTBOX_INVALID_ENVELOPE)`와 stricter producer validation은 additive API지만 이전에 DB/native JSON 오류로 늦게 실패하던 입력을 조기에 거부하므로 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.

### `OUT-M17` — ordering 비보장과 deterministic cursor

- 상태: `P2 / DONE`
- [x] UPDATE RETURNING/동일 transaction timestamp가 FIFO를 만들지 않는다고 문서화한다.
- [x] SQL의 “per-aggregate ordering” 오해 주석을 수정한다.
- [x] admin list는 `(created_at,id)`의 정렬 방향과 exclusive boundary를 고정하고 opaque versioned cursor와 `nextCursor`를 제공한다. 기존 Date filter의 호환 경로와 semver를 명시한다.
- [x] strict aggregate/partition FIFO는 `OUT-B01`로 남긴다.

검증: 프로필 A/B/D/F. 기존 `list()`와 Date range filter는 유지하고 deterministic tie-break만 추가했으며 새 `listPage()`/cursor error는 additive다. 누적 작업과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.

### `OUT-M18` — admin pagination, retention, bulk performance

- 상태: `P2 / DONE`; 선행 `OUT-M05`, `OUT-M07–08`, `OUT-M17` 완료.
- [x] stable cursor와 tenant predicate를 결합한다.
- [x] `retryMany` bind-limit chunking과 partial failure 의미를 정한다.
- [x] global stats/full-history count, purge/retention index는 `EXPLAIN ANALYZE` 증거 뒤 추가한다.
- [x] payload/header/error의 보존 기간과 redaction 책임을 문서화한다.

검증: 프로필 A/B/D/F. 10,001건 retry와 20,000행 `EXPLAIN ANALYZE` 증거는 `docs/reports/2026-09-03-out-m18-m19-admin-schema.md`에 기록했다. 새 index와 내부 batch 실행은 additive이며 누적 변경과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.

### `OUT-M19` — schema upgrade와 diagnostic compatibility

- 상태: `P2 / DONE`; 선행 `OUT-M01–02`, `OUT-M05`, `OUT-M10` 완료.
- [x] fresh, v0.1→current, v0.2→current fixture DDL을 release tag/checksum과 함께 고정하고 실제 PostgreSQL로 검증한다.
- [x] claim/lease/next-attempt column과 index/CHECK를 idempotent하게 적용한다.
- [x] schema가 오래됐을 때 generic query error 대신 required/actual version 진단을 제공한다.
- [x] package에 포함되는 SQL asset와 README 명령을 packed tarball에서 검증한다.

검증: 프로필 A/B/D/F. exact v0.1.0/v0.2.1 fixture SHA-256, 2회 적용 unified upgrade, typed startup 진단, Prisma 5/7 exact packed consumer가 통과했다. mandatory migration과 additive public error/export이므로 누적 변경과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.

### `OUT-M20A` — publisher terminal과 tenant-context PostgreSQL E2E

- 상태: `P2 / DONE`; 선행 `OUT-M01`, `OUT-M05–06`, `OUT-M10` 완료.
- [x] 이미 있는 fresh migration·explicit tenant test를 중복하지 않고 publisher final `FAILED`, provider-derived tenant 저장, ambient context 복원을 실제 PostgreSQL에서 검증한다.
- [x] shutdown 중 publisher callback 거부가 retriable Outbox 상태로 남는지는 dev-only fake transport로 검증한다.

검증: 프로필 A/B/C/F. terminal `FAILED`는 retry/error와 claim/lease 정리를 저장하고 `processed_at`은 성공 `SENT` 시각 의미를 유지해 null이다. provider-derived row는 persisted tenant를 local handler의 ambient context로 복원한 뒤 바깥 context를 비운다. runtime/API/schema 변화는 없다.

### `OUT-M20B` — LISTEN/NOTIFY wakeup과 fallback PostgreSQL E2E

- 상태: `P2 / DONE`; 선행 `OUT-M03`, `OUT-M09` 완료.
- [x] LISTEN 준비 전/후 notification, burst coalescing, notification loss 뒤 polling fallback, reconnect 세대를 deterministic barrier로 검증한다.
- [x] 임의 sleep 대신 readiness hook과 eventual assertion을 사용한다.

검증: 프로필 A/B/C/F. 실제 `pg.Client`의 LISTEN 완료, 101 notification 관측, reconnect generation 2 LISTEN, dispatch-success promise를 barrier로 사용했다. timeout은 실패 guard일 뿐 성공 판정용 sleep이 아니다. runtime/API/schema 변화는 없다.

### `OUT-M20C` — shutdown/retry/upgrade 통합 PostgreSQL E2E

- 상태: `P2 / DONE`; 선행 `OUT-M02`, `OUT-M05`, `OUT-M19` 완료.
- [x] 미시작 claim shutdown 반납, 서로 다른 process config에서도 저장된 due time 사용, fresh/v0.1/v0.2 upgrade 뒤 runtime 처리를 통합 fixture로 검증한다.
- [x] 실제 co-located Jobs lifecycle 조합은 `JOBS-M22`와 `TEN-ECO-NEXT`가 소유하며 Outbox에 Jobs runtime dependency를 추가하지 않는다.

검증: 프로필 A/B/C/F. 실제 DB claim commit 뒤 shutdown barrier로 미dispatch `PENDING` 반납을 확인했고, mixed retry config는 stored `next_attempt_at`만 따른다. exact v0.1.0/v0.2.1 fixture upgrade 뒤 보존 pending row가 `SENT`로 처리된다. runtime/API/schema 변화는 없다.

### `OUT-M22` — dev dependency audit remediation

- 상태: `P2 / DONE`; lint 도구 한 묶음만 갱신했고 남은 경로는 `OUT-M22B/C`로 분리했다.
- [x] production audit zero를 `audit:production` CI/release permanent hard gate로 유지한다.
- [x] Prisma CLI/deepmerge/mysql, Jest/Babel, ESLint/brace-expansion/js-yaml, Nest test adapter 경로를 분리했다.
- [x] Prisma 7 지원을 지우는 audit 자동 downgrade를 사용하지 않았다.
- [x] ESLint 10 flat config + TypeScript ESLint 8과 compatible brace lock refresh 한 묶음만 적용했다.
- [x] 남은 dev-only exception에 owner/reason/2026-10-04 expiry와 `OUT-M22B/C`를 지정했다.

검증과 예외: `docs/reports/2026-09-04-out-m22-dev-audit.md`. runtime/peer/API 변화가 없는 개발 도구 갱신이므로 package semver 변화는 없다.

### `OUT-M22B` — Prisma CLI dev advisory 후속

- 상태: `P2 / BLOCKED`; 2026-09-05 online registry 확인 결과 supported Prisma 7 수정 버전이 아직 없다.
- [x] 전체 online audit과 published dependency metadata를 확보했다. 최신 stable Prisma 7은 `7.10.0`이며 `@prisma/config@7.10.0 -> deepmerge-ts@7.1.5`, `prisma@7.10.0 -> mysql2@3.15.3` exact pin이 남아 있다.
- [x] Prisma CLI/client/adapter `7.10.0`과 Prisma 5/6/7 packed control을 보존했다. npm이 제안한 Prisma `6.19.3` downgrade, `latest`의 `8.0.0-rc.13`, out-of-range override는 채택하지 않았다.
- [ ] advisory가 제거된 supported Prisma 7 patch가 게시되면 exact control을 함께 갱신하고 audit/generate/E2E/packed 검증을 실행한다.
- 남은 audit: Prisma 경로 high 4 dependency nodes; production 0. Owner: Outbox maintainers. 예외 만료는 기존 2026-10-04 또는 다음 supported Prisma patch 중 빠른 시점을 유지하며 자동 연장하지 않는다.

증거: [OUT-M22B/C report](reports/2026-09-05-out-m22bc-dev-audit.md), [online audit 및 registry 원본](reports/2026-09-05-out-m22bc-audit/metadata.json). 코드 수정 완료로 간주하지 않는다.

### `OUT-M22C` — Jest/Nest dev advisory 후속

- 상태: `P2 / DONE`; Nest/Jest/Babel advisory 경로를 compatible update로 제거했다.
- [x] Nest common/core/platform-express/testing과 CI/release/packed/README exact control을 `11.2.3`으로 동기화했다.
- [x] Jest `29.7.0`/ts-jest `29.4.9`를 유지하며 `js-yaml 3.15.2`, Babel core `7.29.7`, browserslist `4.28.9`, body-parser `2.3.0`, qs `6.16.0`으로 호환 갱신했다. Jest major 변경이나 override가 필요하지 않았다.
- [x] 새 lock의 전체 online audit 원본을 artifact로 저장했다. 전체 9 → 4 (남은 경로는 OUT-M22B), production 0이며 Nest/Jest 예외를 종료했다.
- [x] clean strict install, unit/coverage 194 tests, PostgreSQL E2E 38 tests, lint/typecheck/build, compatibility/workflow policy를 검증했다. 동일 최종 tgz로 no-pg exports 및 Nest 10/11/12 + Prisma 5/6/7 strict packed PostgreSQL consumers 모두 통과했다.

검증과 exact packed consumer 증거: [OUT-M22B/C report](reports/2026-09-05-out-m22bc-dev-audit.md). runtime/API/peer/schema 및 package semver 변화는 없다.

### `OUT-M23` — explicit root와 SQL package export 계약

- 상태: `P2 / DONE`.
- [x] published v0.2.1 tarball과 repository/packed consumer의 실제 public deep import 사용을 ADR 0008에 기록했다.
- [x] root와 fresh/current 두 SQL asset만 명시적으로 export하고 accidental JS/component SQL internals를 차단했다.
- [x] CJS/type resolution/SQL `require.resolve`/no-optional-pg strict packed consumer를 CI/release gate에 추가했다.
- [x] 기존 accidental deep import 차단을 next pre-1.0 minor(기본 0.3.0)와 migration note 대상으로 결정했다.

검증: baseline manifest RED, release artifact exact export-map assertion, no-`pg` strict packed consumer PASS. 결정: `docs/adr/0008-explicit-package-exports.md`.

### `OUT-M24` — 역사 문서와 현재 handover 정리

- 상태: `P2 / DONE`.
- [x] old handover/spec/plan/SOLID report 상단에 `HISTORICAL`, `COMPLETED`, `SUPERSEDED`와 이 문서 링크를 추가했다.
- [x] handover의 완료된 v0.2 항목을 현재 상태 표로 바꿔 unchecked backlog 오인을 제거했다.
- [x] 아직 유효한 poller SRP는 `OUT-M31`, packed public typing은 `OUT-M25`에만 연결하고 과거 작업 지시를 복사하지 않았다.

### `OUT-M25` — typechecked packed examples

- 상태: `P2 / READY`; 선행 `OUT-M06`, `OUT-M11`, `OUT-M23` 완료.
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

`npm audit --omit=dev`는 `audit:production`으로 CI/release에서 실행하는 hard zero gate다. 전체 `npm audit`는 `OUT-M22B`의 owner/reason/expiry가 있는 dev-only 예외 evidence (`OUT-M22C` 예외는 2026-09-05 종료)이며 일반 P0/P1의 자동 hard-fail 조건이 아니다. 여기에 exact tgz digest, allowlist, registry integrity/attestation, workflow permissions, tag/main ancestry, GitHub ruleset/npm environment 증거를 추가한다.

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

| 날짜       | Task        | 상태       | ref/PR                                           | 검증 결과                                                                                       | 다음 정확한 행동                                                       |
| ---------- | ----------- | ---------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 2026-09-02 | 계획 기준선 | `DONE`     | `origin/main@873f95b` 조사                       | unit 88, lint/typecheck/coverage/audit 기록; fresh DB E2E 미실행                                | `OUT-PLAN-01`로 이 문서만 먼저 review/merge                            |
| 2026-09-03 | `OUT-M01`   | `DONE`     | `codex/out-m01-fenced-claims` working tree       | unit 95, lint/typecheck/build PASS; PostgreSQL E2E 13 PASS; packed Prisma 7 consumer PASS       | 변경 review 후 branch를 commit/push하고 `OUT-M04A` 또는 `OUT-M03` 진행 |
| 2026-09-03 | `OUT-M03`   | `DONE`     | `901865c`                                        | unit 100, lint/typecheck/clean build PASS; timer/notification burst/shutdown race PASS          | local main merge `ad96d8e`에서 `OUT-M02` 진행                          |
| 2026-09-03 | `OUT-M02`   | `DONE`     | `a14d119`                                        | unit 110, PostgreSQL E2E 16, packed Prisma 7 consumer, coverage/lint/typecheck/build PASS       | local main merge `95b4849` 완료; `OUT-M04A` 진행                       |
| 2026-09-03 | `OUT-M04A`  | `DONE`     | local main `9418db9` working tree                | README delivery contract/spec authority/CHANGELOG 대조; scoped format/lint/typecheck/build PASS | `OUT-M04B` PostgreSQL gate와 함께 완료                                 |
| 2026-09-03 | `OUT-M04B`  | `DONE`     | local main `9418db9` working tree                | unit 110; PostgreSQL E2E 19; packed Prisma 7 consumer; coverage/audit/lint/build PASS           | 변경 review 후 commit/push/PR                                          |
| 2026-09-03 | `OUT-M05`   | `DONE`     | `codex/out-m05-persisted-retry-due` working tree | unit 115; PostgreSQL E2E 22; packed Prisma 7 consumer; lint/typecheck/build PASS                | 변경 review 후 commit/push/PR하고 `OUT-M06` 정책 결정                  |
| 2026-09-03 | `OUT-M06`   | `DONE`     | `codex/out-m06-tenant-provenance` working tree   | unit 129; PostgreSQL E2E 22; packed Prisma 7 consumer; lint/typecheck/clean build PASS          | 변경 review 후 commit/push/PR하고 `OUT-M08` admin 상태 전이 CAS 진행   |
| 2026-09-03 | `OUT-M08`   | `DONE`     | `01f3fcd`                                        | unit 134; PostgreSQL E2E 25; packed Prisma 7 consumer; lint/typecheck/clean build PASS          | local main merge `707eb59` 완료; `OUT-M07` 진행                        |
| 2026-09-03 | `OUT-M07`   | `DONE`     | `4097583`                                        | unit 145; PostgreSQL E2E 26; packed Prisma 7 consumer; lint/typecheck/build PASS                | local main merge 완료; 다음 `READY` P1인 `OUT-M09` 진행                |
| 2026-09-03 | `OUT-M09`   | `DONE`     | `codex/out-m09-listener-lifecycle` working tree  | unit 155; PostgreSQL E2E 26; packed Prisma 7 consumer; lint/typecheck/clean build PASS          | 변경 review 후 commit/push/PR하고 다음 `READY` P1인 `OUT-M10` 진행     |
| 2026-09-03 | `OUT-M10`   | `DONE`     | `codex/out-m10-runtime-invariants` working tree  | unit 170; PostgreSQL E2E 27; packed Prisma 7 consumer; lint/typecheck/clean build PASS          | 변경 review 후 commit/push/PR하고 다음 `READY` P1인 `OUT-M11` 진행     |
| 2026-09-03 | `OUT-M11`   | `DONE`     | local main `13bfb8c` working tree                | unit 174; Nest 11 source + Nest 10 packed async DI; lint/typecheck/build PASS                   | 변경 review 후 commit/push/PR                                          |
| 2026-09-03 | `OUT-M12`   | `EXTERNAL` | local main `13bfb8c` working tree                | workflow policy 10 pinned refs PASS; production audit 0; GitHub before-state captured           | 관리자 인증으로 main/tag ruleset와 npm environment policy 적용         |
| 2026-09-03 | `OUT-M13`   | `DONE`     | local main `13bfb8c` working tree                | exact packed Prisma 5.22.0/6.19.3 + preserved 7.10.0 PostgreSQL consumers PASS                  | 원격 Node 22 CI lane 확인 후 release 선행 작업 계속                    |
| 2026-09-03 | `OUT-M14`   | `DONE`     | local main `5a032e3` working tree                | Node 22/24 exact Nest 12/Schedule 12 packed PostgreSQL consumers; unit/E2E/policy/audit PASS    | 변경 review 후 commit/push/PR하고 원격 Node 22/24 matrix 확인          |
| 2026-09-03 | `OUT-M21`   | `BLOCKED`  | local main `7650295` working tree                | pack-once 117 files/55,692 B; exact Nest 10/11/12 + Prisma 5/6/7 consumer; policy 19 refs PASS  | `OUT-M12` 완료 후 manual run과 next tag publish/attestation/rerun 증거 |
| 2026-09-03 | `OUT-M15`   | `DONE`     | local main `2c83fa1` working tree                | hook rollback/mutation/error contract; unit 188, E2E 28, packed Prisma 7 consumer PASS          | 변경 review 후 OUT-M15–17을 함께 commit/push/PR                        |
| 2026-09-03 | `OUT-M16`   | `DONE`     | local main `2c83fa1` working tree                | stable envelope error, 1,000-row chunk, duplicate discovery; source/DB/packed PASS              | 변경 review 후 OUT-M15–17을 함께 commit/push/PR                        |
| 2026-09-03 | `OUT-M17`   | `DONE`     | local main `2c83fa1` working tree                | `(created_at,id)` cursor unit + identical timestamp PostgreSQL E2E PASS                         | 선행이 해소된 `OUT-M18`을 `READY`로 전환                               |
| 2026-09-03 | `OUT-M18`   | `DONE`     | local main `c1bd9e6` working tree                | unit 193; PostgreSQL E2E 31; 10,001 retry + 20,000행 EXPLAIN; packed Prisma 5/7 PASS            | 완료된 M19와 함께 review/commit/push/PR                                |
| 2026-09-03 | `OUT-M19`   | `DONE`     | local main `c1bd9e6` working tree                | v0.1.0/v0.2.1 checksum + 2회 upgrade; typed schema 진단; exact tgz SQL/README 검증 PASS         | 선행이 해소된 `OUT-M20C`를 `READY`로 전환                              |
| 2026-09-03 | `OUT-M20A`  | `DONE`     | local main `fc782b5` working tree                | publisher final FAILED, provider tenant/ambient context, shutdown rejection; unit/E2E PASS      | M20B/C와 함께 review/commit/push/PR                                    |
| 2026-09-03 | `OUT-M20B`  | `DONE`     | local main `fc782b5` working tree                | real LISTEN readiness/burst/loss fallback/reconnect generation; PostgreSQL E2E 38 PASS          | M20A/C와 함께 review/commit/push/PR                                    |
| 2026-09-03 | `OUT-M20C`  | `DONE`     | local main `fc782b5` working tree                | real shutdown release, mixed retry due, v0.1/v0.2 upgraded runtime; packed Prisma 7 PASS        | `OUT-M26` 선행 해소; 다음 낮은 번호 `OUT-M22` 진행                     |
| 2026-09-04 | `OUT-M22`   | `DONE`     | local main `f54a781` working tree                | production audit 0; ESLint 10 lint, unit 194, build PASS; remaining exceptions split            | `OUT-M22B/C`를 만료 전 각각 처리                                       |
| 2026-09-04 | `OUT-M23`   | `DONE`     | local main `f54a781` working tree                | published 0.2.1 surface 조사; exact export map + no-pg packed CJS/type/SQL consumer PASS        | next pre-1.0 minor migration note 유지                                 |
| 2026-09-04 | `OUT-M24`   | `DONE`     | local main `f54a781` working tree                | old handover/spec/plan/SOLID authority banners와 v0.2 status mapping 검토                       | 현재 backlog는 이 문서만 사용                                          |
| 2026-09-05 | `OUT-M22B` | `BLOCKED` | local `5319d79` → `codex/out-m22bc-dev-audit` working tree | online audit/registry metadata: Prisma 7.10.0 exact pins remain; production 0 | supported Prisma 7 fix 게시 시 재검증; 기존 2026-10-04 예외 만료 유지 |
| 2026-09-05 | `OUT-M22C` | `DONE` | local `5319d79` → `codex/out-m22bc-dev-audit` working tree | Nest 11.2.3 + compatible Babel/YAML/Express refresh; audit 9 → 4, unit 194/E2E 38 PASS | local 변경 review 및 원격 CI; 남은 advisory는 OUT-M22B |

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
Start ref / end ref: local main@ad96d8e / a14d11996902e6ea70777a87a723d4f2dfa38a65
Changed files: claim-on-demand poller, active lease heartbeat와 expired recovery/shutdown release, lease options/export, fresh/upgrade SQL, unit/PostgreSQL tests, README/CHANGELOG, ADR 0002, maintenance plan
Contract / semver decision: lease.duration은 명시값이 deprecated stuckThreshold alias보다 우선한다. heartbeatInterval은 duration/2 미만이며 기본 duration/3, heartbeatFailureTolerance 기본 1이다. recovery는 retry budget을 소비하지 않는다. live heartbeat가 유지되는 영구 callback hang은 자동 회수하지 않고 application timeout/process termination이 필요하다. 0.2.x poller는 heartbeat를 쓰지 않으므로 lease-aware runtime 시작 전에 drain해야 한다. additive public option/schema migration이므로 기존 OUT-M01과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 PostgreSQL RED max concurrent callback 2로 FAIL; npm ci 649 packages; unit 9 suites/110 tests PASS; PostgreSQL E2E 16 PASS; final packed 첫 시도는 정리된 DB 때문에 connection FAIL, 격리 DB 재시작 뒤 Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS (sha512-9hWoNp4lFr5t4NBgoSkkRp4Mp2aVrXOkXScMiAHnT7ObOawOuKh5mH4iA6OD4UMZKLuGbXEx1LXmbIS7wKRnfw==); coverage statements 95.33%, branches 84.81%, functions 99.05%, lines 96.06%; lint/typecheck/build PASS; production audit 0; full audit 10 dev-only (high 7, moderate 1, low 2); git diff --check PASS
Unverified paths and reason: 없음. OUT-M02 범위의 profile B/C/E와 packed consumer를 실행했다.
External PR, run, release evidence: local commit a14d119와 local main merge 95b4849. push/PR/release는 수행하지 않았다.
Remaining risk: heartbeat loss 뒤 이미 시작된 외부 side effect는 취소할 수 없어 at-least-once/idempotency가 필요하다. live heartbeat가 유지되는 영구 hang은 운영 timeout/termination이 필요하다. 실제 crash-window release gate는 OUT-M04B 범위다.
Next exact action: 완료. local main merge 95b4849에서 다음 최저 미완료 P0인 OUT-M04A를 진행한다.
```

### `OUT-M04A` 종료 인계

```text
Task: OUT-M04A
State: DONE
Start ref / end ref: local main@9418db9 / local main@9418db9 working tree (uncommitted)
Changed files: README delivery contract와 멱등 consumer 예제, historical v0.2.0 Draft authority banner, CHANGELOG, maintenance plan
Contract / semver decision: polling/local/publisher는 모두 at-least-once다. idempotency_key와 partition_key는 metadata이며 package가 uniqueness, dedupe, ordering을 제공하지 않는다. Outbox SENT는 local handler/publisher callback 성공 뒤 fenced terminal write를 뜻하며 downstream consumer 성공을 뜻하지 않는다. 공개 API/schema/runtime 변화가 없는 문서 정정이므로 독립적으로 patch-compatible이나, OUT-M01–02의 next pre-1.0 minor release에 함께 포함한다.
Commands and exact results: README/package/spec/code 대조 PASS; README/CHANGELOG/plan/E2E Prettier PASS; lint PASS; build typecheck와 clean build PASS; git diff --check PASS
Unverified paths and reason: 없음. 현재 root README를 package contract로, 0.2.0 spec을 historical Draft로 명시했다.
External PR, run, release evidence: 없음. CI/release job의 PostgreSQL E2E 실행 경로는 repository workflow에서 확인했으며 push/PR/release는 수행하지 않았다.
Remaining risk: 멱등 side effect의 durable store와 atomicity는 consumer 책임이다. strict FIFO와 inbox/dedupe helper는 P4 연구 범위다.
Next exact action: 완료. OUT-M04B의 실제 PostgreSQL gate와 함께 변경 review 후 commit/push/PR한다.
```

### `OUT-M04B` 종료 인계

```text
Task: OUT-M04B
State: DONE
Start ref / end ref: local main@9418db9 / local main@9418db9 working tree (uncommitted)
Changed files: PostgreSQL E2E에 두 poller initial claim, publisher accept-before-SENT process-loss redelivery, notification/poll fallback coalescing gate 추가; CHANGELOG와 maintenance plan 갱신
Contract / semver decision: 새 production 동작/API/schema 변화는 없다. M01–03의 claim token, lease heartbeat/recovery, stale CAS, single-flight coordinator를 release-blocking PostgreSQL regression으로 고정했다. 외부 side effect exactly-once는 계속 비보장이다.
Commands and exact results: unit 9 suites/110 tests PASS; PostgreSQL E2E 1 suite/19 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS (sha512-1AJAvwlzHF5STzSrAa7RKwLYBSjF9jgypwFzyKEEXccmKFSqmR1GXu+8uJ5joI4r74o0UQ6ssj5Z8bG1Wn4dXQ==); coverage statements 95.33%, branches 84.81%, functions 99.05%, lines 96.06%; lint/typecheck/build PASS; production audit 0; full audit 10 dev-only (high 7, moderate 1, low 2); README/CHANGELOG/plan/E2E Prettier와 git diff --check PASS
Unverified paths and reason: 실제 원격 GitHub Actions run은 push 전이므로 미실행이다. CI와 release workflow 모두 PostgreSQL 16 service에서 npm run test:e2e를 필수 실행하므로 새 fixture가 기존 gate에 포함됨을 정적으로 확인했다.
External PR, run, release evidence: 없음. local disposable compose project outbox-out-m04-20260903에서 검증했고 작업 종료 시 제거했다.
Remaining risk: process-loss test는 process kill 대신 publisher accept 직후 남는 실제 DB snapshot(PROCESSING + expired lease)을 결정적으로 구성한다. 실제 cross-package broker/worker crash/restart는 TEN-ECO-NEXT 범위다.
Next exact action: 변경 review 후 OUT-M04A/B 파일만 commit/push/PR하고, 다음 최저 미완료 P1인 OUT-M05를 진행한다.
```

### `OUT-M05` 종료 인계

```text
Task: OUT-M05
State: DONE
Start ref / end ref: local main@a34ef20 / codex/out-m05-persisted-retry-due working tree (uncommitted)
Changed files: poller persisted due-time claim/failure transitions와 retry validation, admin manual retry invariants, OutboxRecord/option types, fresh/0.1/0.2 upgrade SQL과 pending index, unit/PostgreSQL/packed-consumer contract tests, README/CHANGELOG, maintenance plan
Contract / semver decision: failure transition은 PostgreSQL NOW()에서 next_attempt_at을 한 번 저장하고 모든 poller가 stored due만 사용한다. NULL due는 retry_count=0인 미실패 PENDING row만 즉시 eligible하다. retry.maxDelay 기본 24시간과 2,147,483,647ms hard bound를 두고 exponential delay는 exponentiation 전에 cap에 포화하며 invalid timing은 module construction에서 거부한다. manual retry는 retry_count를 유지하고 last_error/processed_at을 비운 뒤 next_attempt_at=NOW()로 즉시 due를 만든다. additive required schema, public option, OutboxRecord.nextAttemptAt 추가이므로 앞선 작업과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused poller 1 FAIL/40 skipped; clean unit 9 suites/115 tests PASS; PostgreSQL 16 E2E 1 suite/22 tests PASS. packed consumer 뒤 첫 E2E 재실행은 suite beforeAll의 Prisma request error로 전부 실패했으나 container는 healthy/error-log 없음이었고 변경 없는 즉시 재실행 22 PASS로 비재현; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-R2MNKBjujQaTQ0sl2Qq7mCNYFCqW71UWKEDgGDg2Nkos8CJlzmtso/bxqI29Yz2uOdE/tLoah1yoqhoWXPV5mw==); lint, build typecheck, clean build, scoped Prettier, git diff --check PASS
Unverified paths and reason: OUT-M19가 소유한 historical v0.1/v0.2 통합 upgrade matrix와 원격 GitHub Actions는 이 working tree에서 실행하지 않았다. 이 작업의 idempotent current-schema upgrade와 legacy pending retry backfill은 실제 PostgreSQL에서 검증했다.
External PR, run, release evidence: 없음. commit/push/PR/release는 수행하지 않았다.
Remaining risk: 0.2.x poller는 next_attempt_at을 쓰지 않으므로 migration 전에 drain해야 한다. migration 시 기존 PENDING/PROCESSING retry는 보수적으로 즉시 due가 된다. 대량 pending query/index 성능 기준은 OUT-M18 범위다.
Next exact action: diff를 review한 뒤 OUT-M05 파일만 commit/push/PR하고, 다음 최저 미완료 P1인 OUT-M06 tenant producer provenance 정책을 결정한다.
```

### `OUT-M06` 종료 인계

```text
Task: OUT-M06
State: DONE
Start ref / end ref: local main@8bfd5b90414686797fe76dea65428eb4a186b7ad / codex/out-m06-tenant-provenance working tree (uncommitted)
Changed files: emitter tenant resolution/validation, emit/tenancy/hook public types and exports, unit and strict packed-consumer contracts, README/CHANGELOG, ADR 0003, maintenance plan
Contract / semver decision: tenancy.policy는 optional(기본, non-tenant 호환), required, require-match를 제공한다. undefined는 provider fallback이고 null은 거부하며 global event는 tenantScope: 'global'로만 명시한다. explicit/provider 값은 trim/coerce 없이 non-empty canonical string만 허용하고 require-match는 exact mismatch/provider 부재를 fail-closed한다. public option 추가와 tenantId null type tightening 때문에 앞선 작업과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused emitter 1 FAIL/12 PASS ({tenantId: undefined}가 NULL); 구현 뒤 focused emitter 26 PASS; full unit 9 suites/129 tests PASS; lint PASS; build typecheck PASS; clean build PASS; PostgreSQL 16 E2E 1 suite/22 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-Ej61y6CwrJF45BnE/Pi3mp+TzBuC2ewBShUYVfKXuRgouYNAZsT0F6QgRb6SFedvTxpiYzUMknJ+2oKUR+p1TA==); scoped Prettier와 git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions는 push 전이므로 미실행이다. OUT-M20A가 소유한 publisher final FAILED/provider-derived tenant 전용 PostgreSQL E2E는 중복 추가하지 않았다.
External PR, run, release evidence: 없음. local disposable compose project outbox-out-m06-20260903에서 검증했으며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: optional 정책은 tenant가 없을 때 호환성을 위해 NULL을 허용하므로 tenant attribution이 필수인 애플리케이션은 required 또는 require-match를 선택해야 한다. tenant-safe admin authorization은 OUT-M07, async provider DI는 OUT-M11 범위다.
Next exact action: diff를 review한 뒤 OUT-M06 파일만 commit/push/PR하고, 선행이 완료된 OUT-M08 admin 상태 전이 CAS를 진행한 뒤 OUT-M07 tenant-safe admin 경계를 연다.
```

### `OUT-M08` 종료 인계

```text
Task: OUT-M08
State: DONE
Start ref / end ref: local main@f6d8d6cd652bf830afadc69e458b78cc4c06bb15 / 01f3fcd134ff091eb1a607cc4630f36d8e4db593
Changed files: admin retry/markFailed CAS와 공개 mutation result type/export, source-state/invariant unit·PostgreSQL race tests, README/CHANGELOG, ADR 0004, maintenance plan
Contract / semver decision: retry는 FAILED→PENDING, markFailed는 PENDING→FAILED, purgeSent는 cutoff 이전 SENT 삭제만 허용하고 PROCESSING은 모든 admin mutation에서 제외한다. retry/markFailed는 applied | not_found | conflict(currentStatus) | lost_claim 판별 결과를 반환한다. retryMany/purgeSent는 source predicate를 가진 count-returning batch API를 유지한다. boolean 반환형과 markFailed 허용 상태를 바꾸므로 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused admin 9 FAIL/14 PASS; 구현 뒤 focused admin 23 PASS; npm ci 649 packages; full unit 9 suites/134 tests PASS; PostgreSQL 16 E2E 1 suite/25 tests PASS; strict packed 첫 sandbox 실행은 registry metadata 미해결로 @nestjs/common@undefined ERESOLVE, network 허용 재실행에서 exact Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-DZaW+qrdviTVhvnCj+A6obad4YV23FIdUEV8ryLPV8+CweRcKnqI3hJA3wFAfjlUJ5PKdP2IZH8W5rTK/1+tnw==); lint, build typecheck, clean build, scoped Prettier PASS; git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions는 push 전이므로 미실행이다. tenant-scoped read/mutation authorization은 OUT-M07 범위라 이 작업에 포함하지 않았다.
External PR, run, release evidence: local commit 01f3fcd와 local main merge 707eb59. local compose PostgreSQL 16과 branch-local packed tarball로 검증했으며 push/PR/release는 수행하지 않았다.
Remaining risk: global OutboxAdminService는 아직 trusted control-plane/tenant-safe surface로 분리되지 않아 application authorization이 필요하다. OUT-M07이 바로 이어서 소유한다. retryMany의 per-id 결과와 대량 성능은 OUT-M18 범위다.
Next exact action: 완료. local main merge 707eb59에서 OUT-M07 privileged/tenant-safe admin 경계를 시작했다.
```

### `OUT-M07` 종료 인계

```text
Task: OUT-M07
State: DONE
Start ref / end ref: local main@707eb59bd7800dded1535a3b91db54c1205663e8 / 4097583ff89b6494a7107009fff5ce1b306d57da
Changed files: privileged operator/compatibility alias와 tenant-scoped admin services, tenant SQL predicates와 public list type/export/module wiring, unit/PostgreSQL/packed-consumer isolation contracts, README/CHANGELOG, ADR 0005, maintenance plan
Contract / semver decision: OutboxOperatorService는 모든 tenant를 볼 수 있는 trusted global control-plane API다. OutboxAdminService는 같은 Nest token/instance의 deprecated compatibility alias다. OutboxTenantAdminService.forTenant(expectedTenantId)는 canonical fixed scope를 만들고 list/get/stats/health/retry/mark/retryMany/purge의 모든 SQL에 tenant_id predicate를 강제한다. cross-tenant 단건 id는 존재 여부를 숨기기 위해 null/not_found, batch는 적용 건수에서 제외한다. package는 authentication/RBAC/controller를 구현하지 않고 caller가 trusted context에서 tenant authorization을 완료해야 한다. additive service/type과 deprecated alias이므로 앞선 작업과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused admin은 새 export 부재 TypeScript 2 errors; 구현 뒤 focused admin/module 2 suites/42 tests PASS; full unit 9 suites/145 tests PASS; PostgreSQL 16 E2E 1 suite/26 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-7u9NqSKP9mTBCbSYTEHNuaiw0LNpEi9Gcdl3uEbC3yp9qlWz90HTHtq6w/AW1/UDaxurHlSUVDtclVGtAxCTcg==); lint, build typecheck/build, scoped Prettier PASS; git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions는 push 전이므로 미실행이다. host application의 실제 authentication/RBAC/HTTP controller는 package 비범위라 fixture를 추가하지 않았다.
External PR, run, release evidence: local commit 4097583과 local main merge 완료. local compose PostgreSQL 16과 branch-local packed tarball로 검증했으며 push/PR/release는 수행하지 않았다.
Remaining risk: application이 untrusted request tenant id를 authorization 없이 expectedTenantId로 전달하면 SQL scope는 그 값을 충실히 적용하므로 caller authorization은 필수다. cursor/pagination과 batch 결과·성능은 OUT-M18 범위다.
Next exact action: 완료. local main에서 다음 최저 미완료 P1인 OUT-M09 LISTEN/NOTIFY lifecycle을 진행한다.
```

### `OUT-M09` 종료 인계

```text
Task: OUT-M09
State: DONE
Start ref / end ref: local main@de216bc59e31e619f65a24f55b7ccda2862561f6 / codex/out-m09-listener-lifecycle working tree (uncommitted)
Changed files: listener generation/reconnect/cleanup lifecycle, typed wakeup init error와 public export, optional client listener-removal interface, unit lifecycle contracts, README/CHANGELOG, maintenance plan
Contract / semver decision: polling이 켜져 있으면 client factory/connect/LISTEN 초기 실패를 polling fallback으로 degrade하고 background reconnect한다. polling과 wakeup이 모두 disabled이거나 polling disabled 상태에서 wakeup init이 실패하면 OutboxWakeupUnavailableError(code OUTBOX_WAKEUP_UNAVAILABLE)로 fail-fast한다. reconnectDelay는 첫 지연이며 연속 실패는 60초 cap의 exponential backoff를 사용하고 성공 시 reset한다. 교체 전 지원되는 listener를 제거하고 end()를 완료하며 제거 API가 없는 custom client는 generation으로 stale callback을 무효화한다. additive public error/interface와 reconnect/fail-fast 동작 계약이므로 누적 변경과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused listener 2 FAIL/13 PASS(초기 connect reject, old client end 0회); 구현 뒤 focused listener 23 PASS; full unit 9 suites/155 tests PASS; PostgreSQL 16 E2E 1 suite/26 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-Wew4I/0wl8hC9EbJpmB5SAiW9SH5672qaRCgjvb1i8ll9Y6eGqaMyDwu1uLCp21yaxHTWZrEgkf+S07FnFYRvA==); lint, build typecheck, clean build, scoped Prettier, git diff --check PASS
Unverified paths and reason: 실제 PostgreSQL server 강제 disconnect/notification-loss fallback은 OUT-M20B의 deterministic integration fixture 범위라 중복 추가하지 않았다. 원격 GitHub Actions는 push 전이므로 미실행이다.
External PR, run, release evidence: 없음. 최종 tree는 local disposable compose project outbox-out-m09-final-20260903에서 검증하고 종료했으며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: polling disabled 구성은 LISTEN 연결이 런타임에 끊긴 동안 delivery가 reconnect까지 지연된다. custom client의 end()가 영구 미완료면 안전한 교체/shutdown도 그 transport promise를 기다린다. notification loss/fallback의 실제 PostgreSQL 장애 주입은 OUT-M20B가 소유한다.
Next exact action: diff를 review한 뒤 OUT-M09 파일만 commit/push/PR하고, 다음 최저 미완료 P1인 OUT-M10 runtime option/state invariant validation을 진행한다.
```

### `OUT-M10` 종료 인계

```text
Task: OUT-M10
State: DONE
Start ref / end ref: local main@3e8788db870fd87ff2501bd0948a2ac8bc0284f2 / codex/out-m10-runtime-invariants working tree (uncommitted)
Changed files: sync/async runtime option validator와 typed configuration/persisted-invariant errors, delivery transport validation, poller/admin persisted row parser, fresh/upgrade CHECK SQL, unit/PostgreSQL fixtures, README/CHANGELOG, ADR 0006, maintenance plan
Contract / semver decision: polling.interval은 1..2147483647, batchSize는 1..10000, maxRetries는 PostgreSQL positive INT, retry/lease/reconnect timer 값은 setTimeout-compatible safe integer로 제한한다. publisher mode는 기본 LocalTransport를 거부하고 publish 또는 explicit legacy dispatch transport를 요구한다. poller/admin row는 status/retry/date/JSON shape를 검증하며 위반 시 event/field가 포함된 OUTBOX_PERSISTED_INVARIANT_VIOLATION으로 fail-closed한다. fresh/upgrade schema는 retry count/limit, payload/headers object, non-PROCESSING claim metadata CHECK를 적용한다. additive public errors와 stricter startup/schema contract이므로 누적 변경과 같은 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: 첫 RED focused module/poller 11 FAIL/56 PASS(음수 stuckThreshold는 선행 lease validation으로 이미 PASS); 구현 뒤 full unit 9 suites/170 tests PASS; PostgreSQL 첫 sandbox 실행은 loopback EPERM, 권한 있는 실제 첫 실행은 새 CHECK가 불완전한 stale-transition fixture와 mode 누락을 검출해 4 FAIL/23 PASS, fixture를 유효한 상태 전이로 정정한 최종 PostgreSQL 16 E2E 1 suite/27 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-MmJmTzM5UOEpKomug3qvKcQCv8LHAnbU79R8KpYivIxHbTe4vs5pR+/IhhC8fmnURisccLebwFrXGhmT2VL+vg==); npm pack --dry-run 117 files/54.4 kB PASS; lint, build typecheck, clean build, scoped Prettier, git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions는 push 전이므로 미실행이다. OUT-M19가 소유한 historical v0.1/v0.2 통합 schema 진단/upgrade matrix는 중복 실행하지 않았다.
External PR, run, release evidence: 없음. local disposable compose project outbox-out-m10-20260903과 branch-local packed tarball로 검증했으며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: invariant upgrade는 기존 테이블을 검증하고 CHECK 재적용 동안 lock을 획득하므로 큰 production table은 maintenance window와 사전 corruption query가 필요하다. runtime fail-closed는 손상 row를 자동 수리하거나 격리하지 않으며 OUT-M19가 schema version/diagnostic 경로를 보강한다.
Next exact action: diff를 review한 뒤 OUT-M10 파일만 commit/push/PR하고, 다음 최저 미완료 P1인 OUT-M11 forRootAsync DI와 option ownership을 진행한다.
```

### `OUT-M11` 종료 인계

```text
Task: OUT-M11
State: DONE
Start ref / end ref: local main@13bfb8ce3bdac8f1a01b507a5fd5749016131813 / local working tree (uncommitted)
Changed files: async runtime/registration option types와 export, Nest provider graph wiring, module unit contracts, Nest 10 packed async DI consumer, README/CHANGELOG, maintenance plan
Contract / semver decision: async factory와 OutboxOptionsFactory는 prisma/polling/retry/delivery/tenancy policy 등 runtime 값만 소유한다. transport, tenantProvider, isGlobal은 top-level OutboxAsyncOptions가 소유하며 provider class는 Nest가 imports graph로 생성한다. factory가 registration 값을 반환하면 compile-time never 또는 module compile 오류로 거부한다. public async option shape tightening과 tenantProvider 추가이므로 next pre-1.0 minor 대상으로 결정했다.
Commands and exact results: focused module 1 suite/24 tests PASS; full unit 9 suites/174 tests PASS; lint PASS; build typecheck/build PASS; Nest 10.4.22 packed consumer에서 injected async factory/tenant provider/custom transport generate/typecheck/build/PostgreSQL smoke PASS; Nest 11.2.1 source unit/module contracts PASS; git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions의 Nest 10/11 matrix는 push 전이므로 미실행이다. 두 major의 실제 계약은 local Nest 11 source와 isolated Nest 10 packed runtime으로 검증했다.
External PR, run, release evidence: 없음. commit/push/PR/release는 수행하지 않았다.
Remaining risk: 이미 생성한 tenant provider value를 top-level에 전달하는 형태는 constructor injection을 다시 수행하지 않는다. injection이 필요하면 class를 전달해야 한다.
Next exact action: 변경 review 후 commit/push/PR한다.
```

### `OUT-M12` 종료 인계

```text
Task: OUT-M12
State: EXTERNAL
Start ref / end ref: local main@13bfb8ce3bdac8f1a01b507a5fd5749016131813 / local working tree (uncommitted)
Changed files: release tag/main ancestry authorization, manual dry-run-only path, npm/GitHub Release 권한 분리, immutable action SHA pins, repository-local workflow policy test, GitHub settings evidence report, package scripts, CHANGELOG, maintenance plan
Contract / semver decision: 실제 npm publish는 matching v*.*.* tag push에서만 실행되고 tag commit은 origin/main ancestor여야 한다. workflow_dispatch는 contents-read dry-run만 실행한다. npm job은 contents read + OIDC, GitHub Release job은 contents write만 가진다. package runtime/API 변화가 없는 release hardening이다.
Commands and exact results: npm run test:workflow-policy PASS(immutable action refs 10개); unit 174 PASS; coverage statements 94.53%, branches 88.47%, functions 98.63%, lines 95.55%; production npm audit 0; full audit 10 dev-only(high 7, moderate 1, low 2); GitHub public API before-state는 rulesets=[], npm environment protection_rules=[], can_admins_bypass=true, deployment_branch_policy=null; git diff --check PASS
Unverified paths and reason: main/tag ruleset, required checks, force-push/tag 이동 차단, npm environment reviewer/deployment policy, npm Trusted Publisher 설정의 authenticated 확인은 GitHub 관리자 인증이 필요하다. 현재 gh token은 invalid라 변경하지 않았다. manual dry-run 원격 run도 push 전이라 미실행이다.
External PR, run, release evidence: docs/reports/2026-09-03-out-m12-release-controls.md에 대상 repo/environment, read-only before-state, 정확한 관리자 후속 작업을 기록했다.
Remaining risk: workflow ancestry 검증만으로 Git ref 이동을 막을 수 없다. ruleset과 environment protection이 적용되기 전에는 OUT-M12와 이를 선행으로 하는 OUT-M21/OUT-REL-01을 DONE으로 볼 수 없다.
Next exact action: nestarc/outbox 관리자 자격으로 report의 before-state를 다시 캡처하고 main/tag ruleset과 npm environment policy를 적용한 뒤 API JSON/스크린샷과 manual dry-run run을 기록하고 OUT-M12를 DONE으로 바꾼다.
```

### `OUT-M13` 종료 인계

```text
Task: OUT-M13
State: DONE
Start ref / end ref: local main@13bfb8ce3bdac8f1a01b507a5fd5749016131813 / local working tree (uncommitted)
Changed files: Node 22/Prisma 5.22.0 CI cell, shared Prisma 5/6 strict packed consumer fixture와 runner, release gates, package scripts, README compatibility evidence, CHANGELOG, maintenance plan
Contract / semver decision: @prisma/client peer range ^5 || ^6 || ^7을 유지한다. exact 5.22.0과 6.19.3은 같은 prisma-client-js fixture에서 package root declarations와 shipped create-outbox-table.sql을 소비하고, 7.10.0은 preserved modern prisma-client/adapter fixture를 사용한다. peer range 변경이나 migration은 없다.
Commands and exact results: exact Nest 10.4.22/Schedule 4.1.2/Prisma 5.22.0 strict install, generate, typecheck, build, PostgreSQL emit/poll/admin smoke PASS; 같은 fixture의 exact Prisma 6.19.3 PASS; preserved Nest 11.2.1/Schedule 5.0.1/Prisma 7.10.0 modern packed consumer PASS; source PostgreSQL E2E 1 suite/27 tests PASS; npm pack provenance/integrity assertions PASS
Unverified paths and reason: 새 Node 22 CI cell의 원격 Actions run은 push 전이므로 미실행이다. local host Node는 repository baseline 환경을 사용했지만 exact dependency tuples와 packed runtime은 격리 설치했다.
External PR, run, release evidence: 없음. disposable compose project outbox-out-m11-m13-20260903과 loopback-only DB에서 실행했다.
Remaining risk: Prisma 5는 upstream maintenance 종료 가능성이 있으므로 다음 breaking support 결정은 OUT-M30 compatibility manifest 또는 별도 policy task에서 다룬다.
Next exact action: 변경 review 후 commit/push/PR하고 원격 Node 22 matrix 결과를 확인한다.
```

### `OUT-M14` 종료 인계

```text
Task: OUT-M14
State: DONE
Start ref / end ref: local main@5a032e3 / local main@5a032e3 working tree (uncommitted)
Changed files: engines/Nest/Schedule peers와 lock metadata, Node 22/24 CI·release lanes와 Node 26 canary, exact Nest 12 packed-consumer runner와 compatibility policy, README/CHANGELOG, ADR 0007, maintenance plan
Contract / semver decision: Node 20은 2026-03-24 EOL이므로 legacy lane 없이 지원 종료하고 engines를 >=22로 올린다. Node 22/24만 필수 control/runtime이며 Node 26은 LTS 전 allowed-failure CI canary다. exact Nest 12.0.1 + Schedule 12.0.1 + Prisma 7.10.0 proof 뒤 Nest common/core ^12와 Schedule ^12 peer를 추가한다. Node floor 제거는 breaking support change이므로 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: 현재 peer의 첫 strict install은 @nestjs/common ^10 || ^11 충돌로 ERESOLVE; 임시 candidate Node 24 strict install/generate/typecheck/build/PostgreSQL smoke PASS (sha512-BdmqpZoTfeL2lRyGiac66mvxdMKKSZX4WyJ0EyrAdvRRh0Fr6bqOoIvkSAkBrIfGrwz9K3fawlNQFoj/9bjGvQ==); 최종 manifest는 Node 22와 24에서 exact Nest 12.0.1/Schedule 12.0.1/Prisma 7.10.0/@types-node 22.20.1 strict packed smoke PASS, 동일 tarball sha512-yDyKkI6p2p/SbTy5DZiHIGRykxe1lPNbfFgfCY28vHN1M3x4wNsLRS9E8jyQY/7XF6NkrpNZSsyDSVBLRawomw==; 기존 Nest 11.2.1 packed consumer PASS; unit 9 suites/174 tests PASS; PostgreSQL E2E 1 suite/27 tests PASS; coverage statements 94.53%, branches 88.47%, functions 98.63%, lines 95.55%; lint/typecheck/build PASS; compatibility policy PASS; release workflow policy 12 immutable refs PASS; isolated-cache npm pack dry-run 117 files/55.7 kB PASS (기본 ~/.npm cache 시도는 기존 root-owned cache로 EPERM); production audit 0; full audit 10 dev-only(high 7, moderate 1, low 2)
Unverified paths and reason: 원격 GitHub Actions의 Node 22/24 matrix와 Node 26 allowed-failure canary는 push 전이라 미실행이다. 로컬 Node 24와 격리 Node 22 container에서 동일 packed artifact를 실제 PostgreSQL 16으로 검증했다.
External PR, run, release evidence: Node 공식 release/EOL 표와 npm의 current NestJS/Schedule manifest를 ADR 0007에 연결했다. commit/push/PR/release는 수행하지 않았다.
Remaining risk: peer range의 모든 조합을 전수 증명하지는 않으며 exact control tuples가 회귀 증거다. Node 26 canary 성공은 지원 선언이 아니고 LTS 승격 뒤 별도 정책 결정이 필요하다.
Next exact action: diff를 review한 뒤 OUT-M14 파일만 commit/push/PR하고 원격 Node 22/24 필수 matrix와 Node 26 allowed-failure canary 결과를 확인한다.
```

### `OUT-M21` 종료 인계

```text
Task: OUT-M21
State: BLOCKED (로컬 구현·검증 완료, OUT-M12와 remote release 증거 대기)
Start ref / end ref: local main@7650295532c26a8da8a9eeb2f7a608371f686632 / local working tree (uncommitted)
Changed files: pack-once release workflow와 immutable artifact upload/download, artifact allowlist/digest/registry/provenance verifier, exact-artifact modern/legacy consumer 입력, workflow policy/attestation parser fixture, CHANGELOG, evidence report, maintenance plan
Contract / semver decision: Node 22 source gate가 package.tgz를 한 번만 만들고 metadata의 SRI/SHA-256/file list/size/source ref와 결합한다. Node 24/manual/publish는 rebuild/repack 없이 그 bytes만 사용한다. existing version은 registry SRI가 같으면 publish를 idempotent skip하고 다르면 fail한다. publish 뒤 npm이 cryptographically verified한 publish/SLSA statements의 subject digest와 repository/tag/commit/workflow가 모두 맞아야 GitHub Release가 진행된다. package runtime/API 변화가 없는 release hardening이다.
Commands and exact results: 첫 RED npm run test:workflow-policy는 missing verify-published job으로 FAIL; 최종 workflow policy 19 immutable action refs PASS; YAML parse, Prettier, git diff --check PASS; unit 9 suites/174 tests PASS; lint, build typecheck, build PASS; PostgreSQL 16 E2E 1 suite/27 tests PASS; pack/verify 117 files, 55,692 packed bytes, 253,963 unpacked bytes, sha512-yDyKkI6p2p/SbTy5DZiHIGRykxe1lPNbfFgfCY28vHN1M3x4wNsLRS9E8jyQY/7XF6NkrpNZSsyDSVBLRawomw==, sha256 3662e508d7eede5a2ef95e59f7e03668d0f2b746c231a6b1c7454c0723a38216; 같은 tgz로 exact Nest 11.2.1/12.0.1 + Prisma 7.10.0과 Nest 10.4.22 + Prisma 5.22.0/6.19.3 install/typecheck/build/PostgreSQL smoke 모두 PASS; local candidate 대 published 0.2.1 different-byte registry guard expected exit 1 PASS; published 0.2.1 identical-byte idempotent skip PASS; 실제 npm 12 signature/attestation bundle로 registry integrity와 publish/provenance subject/ref/commit/workflow end-to-end PASS
Unverified paths and reason: 새 workflow의 GitHub-hosted Node 22/24 artifact upload/download와 manual dry-run은 push 전이라 미실행이다. next version의 실제 publish, 새 attestation, immutable tag rerun은 release event가 필요하다. OUT-M12 repository/tag/environment/Trusted Publisher 보호 설정이 아직 EXTERNAL이다.
External PR, run, release evidence: docs/reports/2026-09-03-out-m21-pack-once.md에 graph, artifact contract, local/public registry evidence, 정확한 remote 후속 작업을 기록했다. commit/push/PR/release는 수행하지 않았다.
Remaining risk: OUT-M12가 끝나기 전에는 tag 이동/환경 우회 차단을 workflow만으로 보장할 수 없다. registry propagation이나 npm signature service 장애는 publish 후 verification을 fail-closed시키며 운영자가 같은 immutable tag run을 재실행해야 한다.
Next exact action: 변경을 review/commit/push한 뒤 OUT-M12 관리자 설정을 완료하고 workflow_dispatch dry-run을 기록한다. 다음 immutable release tag에서 exact artifact digest와 npm attestation 검증을 기록한 뒤 같은 tag workflow를 재실행해 identical-byte skip을 확인하고 OUT-M21을 DONE으로 바꾼다.
```

### `OUT-M15` 종료 인계

```text
Task: OUT-M15
State: DONE
Start ref / end ref: local main@2c83fa1fa8a166cbcfef348c0a5539308ad002f1 / local working tree (uncommitted)
Changed files: readonly emit/poll hook context와 detached onEmit snapshot, rollback/mutation unit contracts, README hook observation 표와 durable audit guidance, CHANGELOG, maintenance plan
Contract / semver decision: onEmit은 insert와 optional pg_notify가 caller-owned transaction에 staged된 뒤 commit 전에 실행되는 attempted observation이며 commit hook이 아니다. 모든 hook은 best-effort snapshot observer이고 throw/reject는 delivery state를 바꾸지 않는다. compliance fact는 같은 transaction의 audit row 또는 별도 durable event로 기록한다. readonly public type tightening은 누적 변경과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: 첫 focused RED에서 rollback/mutation 계약은 구현 전 상태였고 새 cursor/type 테스트와 함께 4 suites FAIL; 최종 unit 9 suites/188 tests PASS; lint PASS; build typecheck/build PASS; PostgreSQL E2E 1 suite/28 tests PASS; strict packed Nest 11.2.1/Prisma 7.10.0 install/typecheck/build/PostgreSQL smoke PASS (sha512-tuxGr85EzAUuPRtBRhVFKFLCZI4gHV9uUk39IJ0WOlSlByLVz01RJ6TsUkDsAPRJpPlJgXQ6NUM4F1qKcDAlKg==); scoped Prettier와 git diff --check PASS
Unverified paths and reason: 원격 GitHub Actions는 push 전이라 미실행이다. caller transaction의 실제 rollback은 기존 PostgreSQL E2E가 durable row 부재를 검증하고 새 unit은 onEmit이 rollback 결정 전에 이미 관측됨을 고정한다.
External PR, run, release evidence: 없음. disposable compose project outbox-out-m15-m17-20260903과 branch-local packed tarball로 검증했으며 commit/push/PR/release는 수행하지 않았다.
Remaining risk: hook sink 자체의 durability/ordering은 package가 보장하지 않는다. runtime object freeze도 보장하지 않으며 snapshot mutation 격리만 보장한다.
Next exact action: OUT-M15–17 변경을 함께 review한 뒤 path-scoped commit/push/PR한다.
```

### `OUT-M16` 종료 인계

```text
Task: OUT-M16
State: DONE
Start ref / end ref: local main@2c83fa1fa8a166cbcfef348c0a5539308ad002f1 / local working tree (uncommitted)
Changed files: typed envelope error/export, producer identifier/JSON/header/date/size validation, emitMany full prevalidation과 1,000-row transaction-preserving chunks, duplicate decorator/discovery guard, unit tests, README/CHANGELOG, maintenance plan
Contract / semver decision: DB VARCHAR와 맞춘 identifier 최대 255자, payload plain JSON object/1 MiB/100 levels, headers canonical key 255자/string value 8,192자/64 KiB, valid occurredAt을 SQL 전에 검증한다. 실패는 OUTBOX_INVALID_ENVELOPE의 field/reason으로 고정한다. emitMany는 12 bind/row를 같은 caller transaction에서 1,000행씩 실행한다. 서로 다른 handler의 event fan-out은 유지한다. additive error API지만 이전 허용 입력을 조기 거부하는 stricter contract라 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: 첫 focused RED는 duplicate decorator/discovery가 throw하지 않고 listPage가 없으며 envelope test가 새 contract type에서 실패함을 확인; 5,000-row 첫 구현은 60,000 variadic args에서 Node RangeError를 재현해 1,000-row로 안전하게 낮춤; 최종 unit 9 suites/188 tests PASS; PostgreSQL E2E 28 PASS; packed Prisma 7 consumer PASS (동일 SRI); lint/typecheck/build/Prettier/git diff --check PASS
Unverified paths and reason: production 규모 payload를 DB에 넣는 성능 benchmark는 OUT-M27 범위이며, 원격 CI는 push 전이라 미실행이다.
External PR, run, release evidence: 없음. local disposable PostgreSQL 16과 packed consumer를 사용했다.
Remaining risk: caller가 chunk 중 DB 오류를 transaction callback 안에서 삼키고 commit하면 일반 transaction 사용 규칙과 마찬가지로 partial staging을 스스로 허용한다. 문서는 rejection을 transaction 밖으로 전파하도록 명시한다.
Next exact action: OUT-M15–17 변경을 함께 review한 뒤 path-scoped commit/push/PR한다.
```

### `OUT-M17` 종료 인계

```text
Task: OUT-M17
State: DONE
Start ref / end ref: local main@2c83fa1fa8a166cbcfef348c0a5539308ad002f1 / local working tree (uncommitted)
Changed files: additive admin page/cursor types와 typed cursor error/export, deterministic list/listPage SQL, unit 및 identical-timestamp PostgreSQL cursor test, SQL index comments, README ordering/cursor contract, CHANGELOG, maintenance plan
Contract / semver decision: 기존 list(options)와 before/after Date range는 유지하고 ORDER BY created_at DESC, id DESC tie-break를 추가한다. 새 listPage는 같은 tuple의 exclusive opaque v1 cursor와 nextCursor를 제공하며 malformed/version/order mismatch는 OUTBOX_INVALID_CURSOR다. 이 순서는 admin traversal 전용이고 delivery FIFO가 아니다. additive API라 누적 변경과 같은 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: 첫 RED는 listPage 부재로 TypeScript 실패; focused unit 구현 후 4 suites/81 tests PASS; full unit 188 PASS; PostgreSQL E2E 28 PASS(동일 created_at 3행을 2+1 페이지로 누락/중복 없이 순회); packed Prisma 7 consumer PASS (동일 SRI); lint/typecheck/build/Prettier/git diff --check PASS
Unverified paths and reason: 대량 page EXPLAIN ANALYZE와 cursor/tenant 복합 index 결정은 선행이 해소된 OUT-M18 범위다. 원격 CI는 push 전이라 미실행이다.
External PR, run, release evidence: 없음. local disposable PostgreSQL 16에서 실제 tuple boundary를 검증했다.
Remaining risk: 페이지 사이 concurrent insert/delete는 snapshot isolation을 제공하지 않는다. cursor는 stable exclusive boundary이지 multi-page transaction snapshot이 아니다. strict aggregate/partition FIFO는 OUT-B01 backlog다.
Next exact action: OUT-M18을 READY로 전환했다. OUT-M15–17 변경 review/commit/push/PR 뒤 OUT-M18 성능/retention scope를 시작한다.
```

### `OUT-M18` 종료 인계

```text
Task: OUT-M18
State: DONE
Start ref / end ref: local main@c1bd9e6 / local working tree (uncommitted)
Changed files: admin status-specific stats와 retryMany dedupe/10,000-id chunking, cursor/tenant/processing/retention indexes, 대량 unit/PostgreSQL EXPLAIN fixture, README retention/redaction/partial-failure 계약, CHANGELOG, evidence report, maintenance plan
Contract / semver decision: retryMany는 기존 count API를 유지하되 chunk는 configured Prisma client에서 독립 commit된다. 뒤 chunk 실패 전 앞 chunk가 commit될 수 있으며 전체 id replay는 FAILED predicate 때문에 안전하다. exact stats는 추정치가 아니므로 retained history에 선형 비용이 남는다. 새 index와 내부 batch 실행은 additive이며 누적 next pre-1.0 minor(기본 0.3.0) 대상으로 결정했다.
Commands and exact results: unit 10 suites/193 tests PASS; lint PASS; build typecheck/build PASS; PostgreSQL 16 E2E 1 suite/31 tests PASS; 10,001-row retry 192 ms, 20,000-row plan/stats fixture 285 ms; plain EXPLAIN cursor 0.075 ms, retention index-only 0.031 ms, exact four-status stats 3.617 ms; Prettier와 git diff --check PASS
Unverified paths and reason: production cardinality/real tenant skew와 autovacuum visibility-map 상태의 장기 benchmark는 OUT-M27 또는 운영 관측 범위다. 원격 GitHub Actions는 push 전이라 미실행이다.
External PR, run, release evidence: 없음. disposable compose project outbox-out-m18-m19-20260903과 docs/reports/2026-09-03-out-m18-m19-admin-schema.md에 실제 plan을 기록했다.
Remaining risk: PostgreSQL은 분포에 따라 tenant composite 대신 narrower FAILED partial index를 선택할 수 있고 exact stats는 모든 qualifying entry를 읽는다. PENDING/PROCESSING/FAILED 자동 TTL은 제공하지 않으며 application이 보존·redaction·archive 정책을 소유한다.
Next exact action: OUT-M19와 함께 diff를 review하고 path-scoped commit/push/PR한다.
```

### `OUT-M19` 종료 인계

```text
Task: OUT-M19
State: DONE
Start ref / end ref: local main@c1bd9e6 / local working tree (uncommitted)
Changed files: unified current upgrade SQL, exact tagged v0.1.0/v0.2.1 fixture와 checksum manifest, typed startup schema guard/error/export, fresh/current/historical PostgreSQL tests, packed artifact/Prisma 5/7 SQL resolution, README/CHANGELOG/evidence report/maintenance plan
Contract / semver decision: runtime은 자동 migration하지 않고 Nest init에서 required 0.3.0 structural inventory를 검사한다. missing/0.1.x/0.2.x/incomplete-current를 OUTBOX_SCHEMA_MISMATCH의 requiredVersion/actualVersion/missing으로 진단한다. mandatory unified migration과 additive public error/export은 누적 next pre-1.0 minor(기본 0.3.0) 대상이다.
Commands and exact results: tag fixture SHA-256 v0.1.0=d6b276fce130d9a494390116f296939ef5725ca210c6ebfd2ea6e1b9e86a2634, v0.2.1=0f17f8a40226f1d6c13172f81f4163cc528d883d13b1381f07db7cec159829cb; 양쪽 unified upgrade 2회 적용과 legacy row 보존 PASS; unit 193, PostgreSQL E2E 31, lint/typecheck/build PASS; exact tgz 69,468 bytes, 134 files, sha512-argw2M3X4tazx0m83Sbssfei210W9dd6rUomJGxBrJqFOchkhcLeP8VJGUtrnznWOepC7i3Z1REdjZSLyXCAJg==, sha256 7f0cb8de969b4ab715b72b9687482c38cc2b8d727f07c495a42fd30e01778cb3; same tgz strict Nest 11.2.1/Prisma 7.10.0과 Nest 10.4.22/Prisma 5.22.0 install/typecheck/build/PostgreSQL smoke PASS; packed README/SQL allowlist PASS
Unverified paths and reason: 원격 GitHub Actions와 실제 production-size lock duration은 push/deployment 전이라 미실행이다. exact Prisma 6은 같은 legacy fixture 계열이지만 이번 세션에서는 5 floor와 7 modern control로 schema guard를 검증했다.
External PR, run, release evidence: 없음. disposable PostgreSQL 16과 branch-local exact tarball을 사용했고 report에 fixture provenance와 plan을 기록했다.
Remaining risk: CHECK 재검증과 old index replacement는 큰 table에서 lock을 획득할 수 있어 maintenance window가 필요하다. structural version은 migration history table이 아니라 required object inventory이며 application이 같은 이름을 다른 정의로 교체한 semantic drift까지 전부 증명하지 않는다.
Next exact action: OUT-M18과 함께 review/commit/push/PR하고 원격 CI를 확인한다. 선행이 해소된 다음 작업은 OUT-M20C다.
```

### `OUT-M20A` 종료 인계

```text
Task: OUT-M20A
State: DONE
Start ref / end ref: local main@fc782b5 / local working tree (uncommitted)
Changed files: publisher/tenant/shutdown contract tests, shared PostgreSQL E2E evidence report, CHANGELOG, maintenance plan
Contract / semver decision: terminal publisher rejection stores FAILED with final retry/error and cleared claim/lease; processed_at remains the successful SENT timestamp and is null for FAILED. Provider-derived tenant is persisted and restored only around local handler execution. No runtime API, schema, or semver change.
Commands and exact results: focused poller unit 51 PASS; full unit 10 suites/194 tests PASS; PostgreSQL 16 E2E 1 suite/38 tests PASS; lint, build typecheck/build, scoped Prettier PASS; strict packed Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS (sha512-cDQpwCY3BMJqGhlZ8c0vBnuGzEwDr4RFcKcTq6MInys+QmKShzqH4tYRc05yW9FVDcz3Y3hLNEz+eg479SQjkA==)
Unverified paths and reason: 원격 GitHub Actions는 push 전이므로 미실행이다.
External PR, run, release evidence: 없음. disposable compose project outbox-out-m20-20260903과 docs/reports/2026-09-03-out-m20-postgresql-e2e.md에 local evidence를 기록했다.
Remaining risk: publisher acceptance와 SENT 사이 process loss는 기존 at-least-once 중복 창으로 남고 consumer 멱등성이 필요하다.
Next exact action: OUT-M20A–C 변경을 함께 review/commit/push/PR하고 원격 PostgreSQL lane을 확인한다.
```

### `OUT-M20B` 종료 인계

```text
Task: OUT-M20B
State: DONE
Start ref / end ref: local main@fc782b5 / local working tree (uncommitted)
Changed files: real pg.Client LISTEN readiness/burst/loss fallback/reconnect E2E, shared PostgreSQL E2E evidence report, CHANGELOG, maintenance plan
Contract / semver decision: LISTEN/NOTIFY remains a latency hint and polling remains the source of truth. Pre-LISTEN notification loss, one queued rerun under 101 notifications, timer fallback without notify, and generation-2 reconnect delivery are test-only evidence; no runtime API, schema, or semver change.
Commands and exact results: full unit 10 suites/194 tests PASS; PostgreSQL 16 E2E 1 suite/38 tests PASS; real LISTEN readiness/burst/loss/reconnect cases PASS; lint, build typecheck/build, scoped Prettier PASS; strict packed Prisma 7 PostgreSQL smoke PASS with the M20A digest
Unverified paths and reason: actual server restart/network partition은 listener unit의 connection failure와 real client disconnect/reconnect 조합으로 대체했다. 원격 CI는 push 전이므로 미실행이다.
External PR, run, release evidence: 없음. loopback-only PostgreSQL 16과 evidence report를 사용했다.
Remaining risk: polling disabled 구성은 runtime disconnect부터 reconnect까지 delivery가 지연되며 notification 자체는 durable queue가 아니다.
Next exact action: OUT-M20A–C 변경을 함께 review/commit/push/PR하고 원격 PostgreSQL lane을 확인한다.
```

### `OUT-M20C` 종료 인계

```text
Task: OUT-M20C
State: DONE
Start ref / end ref: local main@fc782b5 / local working tree (uncommitted)
Changed files: real PostgreSQL shutdown claim barrier, mixed retry due-time regression, historical schema runtime delivery, shared evidence report, CHANGELOG, maintenance plan
Contract / semver decision: shutdown starts after a real claim commit and returns the unstarted row to unclaimed PENDING; process-local retry config cannot override persisted next_attempt_at; exact v0.1.0/v0.2.1 upgraded pending rows are runtime-deliverable. No Jobs dependency and no runtime API/schema/semver change.
Commands and exact results: full unit 10 suites/194 tests PASS; PostgreSQL 16 E2E 1 suite/38 tests PASS; exact historical fixture checksum/upgrade/runtime cases PASS; strict packed Nest 11.2.1/Prisma 7.10.0 PostgreSQL smoke PASS; lint, build typecheck/build, scoped Prettier PASS
Unverified paths and reason: co-located Jobs/Redis/BullMQ crash/restart lifecycle is intentionally owned by JOBS-M22/TEN-ECO-NEXT. 원격 CI는 push 전이므로 미실행이다.
External PR, run, release evidence: 없음. disposable PostgreSQL 16 and evidence report were used; no commit/push/PR/release was performed.
Remaining risk: upgrade lock duration on production-size tables remains OUT-M19 operational risk; this task proves runtime compatibility after upgrade, not online migration performance.
Next exact action: OUT-M20A–C 변경을 함께 review/commit/push/PR한다. 모든 선행이 해소된 OUT-M26은 READY이며 queue상 다음 낮은 번호 READY는 OUT-M22다.
```

### `OUT-M22` 종료 인계

```text
Task: OUT-M22
State: DONE
Start ref / end ref: local main@f54a781 / local working tree (uncommitted)
Changed files: ESLint 10 flat config와 TypeScript ESLint 8 toolchain, compatible brace-expansion lock refresh, production audit CI/release gate, CHANGELOG, dev-audit evidence report, maintenance plan
Contract / semver decision: runtime dependency/peer/API는 바꾸지 않고 lint 도구 한 묶음만 갱신했다. Prisma 7을 downgrade하지 않았고 remaining Prisma CLI와 Jest/Nest dev-only 경로는 owner/reason/2026-10-04 expiry를 둔 OUT-M22B/C로 분리했다. package semver 변화는 없다.
Commands and exact results: baseline full audit 10 dev-only(high 7, moderate 1, low 2); ESLint update 후 online response 7 dev-only(high 5, moderate 1, low 1); compatible brace refresh 결과 1.1.18/2.1.4/5.0.9; npm run audit:production 0; ESLint 10 lint PASS; unit 10 suites/194 tests PASS; build PASS; workflow policy 19 immutable refs PASS
Unverified paths and reason: brace refresh 뒤 full-lock npm audit는 registry ping과 production audit 성공에도 이 host의 npm CLI가 3분 이상 종료되지 않아 최종 aggregate JSON을 확보하지 못했다. offline empty audit를 증거로 사용하지 않았고 OUT-M22B/C가 online artifact를 소유한다.
External PR, run, release evidence: 없음. docs/reports/2026-09-04-out-m22-dev-audit.md에 경로/예외/만료를 기록했다.
Remaining risk: Prisma CLI high advisory와 dev Nest adapter low/moderate advisory가 time-bounded exception으로 남는다. package runtime graph에는 포함되지 않는다.
Next exact action: 2026-10-04 전에 OUT-M22B와 OUT-M22C를 각각 compatible upstream control로 검증한다.
```

### `OUT-M23` 종료 인계

```text
Task: OUT-M23
State: DONE
Start ref / end ref: local main@f54a781 / local working tree (uncommitted)
Changed files: package exports manifest, ADR 0008, release artifact exact-map assertion, no-pg packed consumer fixture/runner, CI/release gates, README migration note, CHANGELOG, maintenance plan
Contract / semver decision: public subpath는 CommonJS/type root와 create-outbox-table.sql/upgrade-to-current.sql 두 개다. accidental dist/**와 component/historical SQL deep import는 ERR_PACKAGE_PATH_NOT_EXPORTED로 차단한다. 이 tightening은 next pre-1.0 minor(기본 0.3.0) migration note 대상이다.
Commands and exact results: HEAD manifest export assertion RED; published 0.2.1 actual tarball 97 entries/33,383 bytes/no export map 확인; final candidate 134 files/69,776 bytes, sha512-9sK7sz8JNRQxp7uENcEIPOI0A3E6jzbbFMWEYOxUrSM8hFLJ44lziiP6Iri10qg7Q7KW+BZFEz7qKrIMyMzM7A==, sha256 d0c014be176a69173ca9700bd251045e053db86a2413ae550bcb583ac30c9836; exact artifact verify PASS; strict no-pg consumer Node16 type resolution/CJS/two SQL/internal blocking PASS; workflow policy PASS
Unverified paths and reason: existing Prisma 7 packed consumer install/typecheck/build는 PASS했지만 local PostgreSQL smoke가 Prisma execute 단계에서 실패했고 Docker daemon도 unavailable이라 DB path를 재검증하지 못했다. 새 export-specific consumer는 DB/pg 비의존 계약을 완전히 검증한다. 원격 CI/release는 push 전이다.
External PR, run, release evidence: published @nestarc/outbox@0.2.1 tarball을 npm registry에서 직접 조사했다. commit/push/PR/release는 수행하지 않았다.
Remaining risk: undocumented deep import 소비자는 0.3.0 업그레이드 전에 root 또는 두 지원 SQL path로 이동해야 한다.
Next exact action: remote CI에서 no-pg exports gate와 기존 PostgreSQL packed consumer를 함께 확인하고 0.3.0 release note를 유지한다.
```

### `OUT-M24` 종료 인계

```text
Task: OUT-M24
State: DONE
Start ref / end ref: local main@f54a781 / local working tree (uncommitted)
Changed files: historical handover, v0.1/v0.2 specs and plans, 2026-04 SOLID report, maintenance plan
Contract / semver decision: old documents remain immutable historical context in content but top-level authority is explicitly COMPLETED/SUPERSEDED. Current contract는 README, current backlog/handover는 이 maintenance plan만 권위 있다. runtime/package semver 변화는 없다.
Commands and exact results: 7개 historical document banner/link review PASS; old handover v0.2 unchecked list를 current status table로 변환; poller SRP는 OUT-M31, packed typing은 OUT-M25에 연결; historical 본문 재포맷 없이 git diff --check PASS
Unverified paths and reason: 없음. 문서 링크는 repository-relative path로 정적 확인했다.
External PR, run, release evidence: 없음. commit/push/PR은 수행하지 않았다.
Remaining risk: 과거 본문 안의 version/line/example은 의도적으로 당시 기록으로 남아 있으므로 banner를 무시하고 현재 지시로 읽으면 안 된다.
Next exact action: 새 작업은 이 문서의 READY queue만 사용한다. 다음 lowest READY는 OUT-M22B다.
```


### `OUT-M22B` 종료 인계

```text
Task: OUT-M22B
State: BLOCKED
Start ref / end ref: local main@5319d79 / codex/out-m22bc-dev-audit working tree (uncommitted)
Changed files: maintenance plan, 2026-09-04 audit report follow-up link, 2026-09-05 audit report 및 online audit/registry JSON artifacts
Contract / semver decision: stable Prisma 7 최신은 7.10.0이며 CLI/config가 mysql2 3.15.3과 deepmerge-ts 7.1.5를 exact pin한다. npm latest 8.0.0-rc.13, audit 제안 6.19.3 downgrade, out-of-range override는 현재 supported patch 범위를 충족하지 않는다. Prisma 5/6/7 control 및 public peer/API/package version은 유지한다.
Commands and exact results: npm view prisma@7 version 및 prisma/config dependencies JSON 확보; 첫 RED online full audit 9 (high 6/moderate 1/low 2), C 수정 후 4 high (@prisma/config/deepmerge-ts/mysql2/prisma); npm audit --omit=dev --json 0. Prisma 7 generate와 PostgreSQL E2E 38 PASS.
Unverified paths and reason: advisory를 제거한 supported Prisma 7 패치가 게시되지 않아 해당 패치의 remediation 검증은 불가능하다. Prisma upstream 대기이며 DONE으로 처리하지 않는다.
External PR, run, release evidence: npm registry 원본과 SHA-256을 docs/reports/2026-09-05-out-m22bc-audit/metadata.json에 기록했다. fetch 후 remote main은 873f95b, npm latest는 0.2.1로 유지된다. PR/push/release는 수행하지 않았다.
Remaining risk: 4 high dev-only dependency nodes가 남는다. Owner Outbox maintainers; 기존 예외 만료 2026-10-04 또는 다음 supported patch 중 빠른 시점. 만료 자동 연장 없음.
Next exact action: supported Prisma 7 수정 버전 게시 시 CLI/client/adapter와 exact controls를 함께 갱신한 후 full/production audit, generate, E2E 및 Prisma 5/6/7 packed controls를 실행한다.
```

### `OUT-M22C` 종료 인계

```text
Task: OUT-M22C
State: DONE
Start ref / end ref: local main@5319d79 / codex/out-m22bc-dev-audit working tree (uncommitted)
Changed files: package manifest/lock, CI/release Nest 11 exact control, modern/no-pg packed consumer runners, README/CHANGELOG, audit report 및 JSON artifacts, maintenance plan
Contract / semver decision: Nest 11 exact control을 11.2.3으로 동기화하고 Jest 29.7.0/ts-jest 29.4.9가 허용하는 js-yaml 3.15.2, Babel core 7.29.7, browserslist 4.28.9, body-parser 2.3.0, qs 6.16.0을 적용했다. Jest major/override 없이 해당 advisory 경로를 제거했다. runtime/API/peer/schema/package semver 변화 없음.
Commands and exact results: clean npm ci --strict-peer-deps PASS (645 packages); unit/coverage 10 suites/194 tests PASS (S 92.08%, B 83.29%, F 96.64%, L 92.92%); PostgreSQL 16 E2E 1 suite/38 tests PASS; lint/build typecheck/clean/build/compatibility/workflow policy PASS; full online audit 9 → 4 (Prisma only), production 0. same final tgz 134 files/69,779 bytes, SHA-256 ce3432fe4878440dcb7810f747b657053073adf6e8e7cd3b0357cf8e64e3d157: no-pg exports 및 Nest 10/11/12 + Prisma 5/6/7 strict PostgreSQL consumers 모두 PASS; scoped formatting/syntax/YAML/hash/link checks와 git diff --check PASS.
Unverified paths and reason: remote Node 22/24 Actions는 push 전이라 미실행이다. local 검증 runtime은 Node 24.11.1/npm 11.6.2다.
External PR, run, release evidence: local disposable loopback PostgreSQL 16과 exact tarball을 사용했다. 선행 29개 commit이 local main에만 있어 현재 5319d79에서 branch를 만들었으며 사용자가 지정한 두 작업을 한 세션에서 진행했다. shared issue claim/commit/push/PR/release는 수행하지 않았다.
Remaining risk: OUT-M22B의 Prisma CLI dev-only 예외만 남는다. 기존 Nest/Jest 예외는 online audit로 종료했다.
Next exact action: 변경 review 후 원격 CI에서 갱신된 Nest 11.2.3 tuple과 기존 Node 22/24, Nest 10/12, Prisma 5/6/7 lanes를 확인한다. OUT-M22B는 supported upstream patch 대기다.
```
