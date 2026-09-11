# README 조사 결과 개선 목록

기준: 2026-09-11 조사, `aa0e55d4c5e68e9d7a2a95d828039ed9851a2c27`, 공개 패키지 버전 0.3.0.
사용자 요청에 따라 아래 12개 항목으로 범위를 고정한다. 각 항목의 수정과 검증 결과를 이 문서에 기록한다.
이번 변경을 이미 배포된 0.3.0의 동작으로 표시하지 않는다. 버전 발행 전까지 변경된 계약은 Unreleased이다.

| ID  | 고정 항목                  | 완료 기준                                                                                                | 상태 |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| R01 | 알림만 사용할 때 전달 중단 | 주기적 polling을 필수로 하고 `polling.enabled: false` 기동을 명시 거절. batch 잔여/예약 재시도 회귀 검증 | 완료 |
| R02 | 관리자 커서 정밀도         | DB 마이크로초를 보존하는 cursor v2, v1 재시작 안내, 동일 시각/마이크로초 PostgreSQL 회귀 검증            | 완료 |
| R03 | 기동 설정 검증             | tenancy policy, hooks, wakeup 및 provider 설정의 실제 검증 범위와 문서를 일치                            | 완료 |
| R04 | 종료 조건                  | `enableShutdownHooks()`, `app.close()`, 고정 30초 drain 한도와 취소 범위 명시                            | 완료 |
| R05 | 문서 모순                  | tenant null/global 정책과 Prisma 7/optional pg 설치 안내 정정                                            | 완료 |
| R06 | 첫 사용 절차               | PostgreSQL 전용/검증 버전, SQL 선행 단계, 완결 예제와 성공 확인 제공                                     | 완료 |
| R07 | 문서 구조·중복             | 목차, 최소 구성, 상세 참조 분리, SQL 복제 제거, 공개/과거/미배포 상태 구분                               | 완료 |
| R08 | broker 메시지 식별자       | Kafka 예제의 event ID·tenant·tracing·idempotency metadata 보존 및 검증                                   | 완료 |
| R09 | AI·설치 패키지 참조        | 배포된 README에서 사용 문서/예제로 연결, 짧은 참조 안내와 tarball 포함 여부 검증                         | 완료 |
| R10 | 검색 메타데이터            | README 제목·npm description/keywords/homepage 개선 및 GitHub topics/homepage 설정                        | 완료 |
| R11 | 공식 사이트 정합성         | 사이트의 실제 현재 상태 확인, 공개판과 미배포 계약을 구분하는 문서·API 연결 정정                         | 완료 |
| R12 | 통합 검증                  | lint/build/unit coverage, 실제 PostgreSQL E2E, packed consumer/examples, 문서 경로/정책 검증             | 완료 |

## 작업 원칙

- 기존 main의 로컬 커밋을 보존한 `codex/readme-audit-improvements` 브랜치에서 작업한다.
- 커서 v1 거절과 polling 비활성화 거절은 사용자에게 보이는 안전성 변경으로 변경 기록에 명시한다.
- 공개 npm 릴리스나 main 병합을 이 목록 완료와 혼동하지 않는다. 공개 사이트 수정은 실제 적용/검증 상태를 별도로 기록한다.
- 사용자 요청인 전체 개선을 이 세션의 작업 범위로 삼는다. 과거 유지보수 문서의 단일 작업 세션 절차로 이번 범위를 축소하지 않는다.

## 검증 기록

### 항목별 결과

- **R01:** `OutboxListener.onModuleInit()`에서 polling 비활성화를 typed configuration error로 거절한다. 주기적 batch 처리와 새 알림 없이 도래한 재시도의 회귀 검사, 실제 Nest sync/async 초기화 검사를 추가했다.
- **R02:** PostgreSQL이 반환한 마이크로초 문자열을 cursor v2에 보존한다. 공개 `Date` 필드는 유지하며 v1은 재탐색을 요구한다. 동일 시각의 여러 행과 같은 밀리초 안의 서로 다른 시각을 실제 PostgreSQL에서 tenant/global 각각 검사했다.
- **R03:** tenancy policy/provider, hooks, wakeup 및 module options 검증을 보완했다. DI로 생성한 tenant provider는 별도 validation provider에서 검사하여 `OUTBOX_OPTIONS` 주입과 충돌하지 않는다. callback의 실제 동작이나 연결 성공을 검증한다는 주장은 하지 않는다.
- **R04:** signal 처리를 위한 `enableShutdownHooks()`, 명시적 `app.close()`, 고정 30초 drain 한도 및 실행 중 callback을 강제 취소하지 않는 범위를 문서화했다.
- **R05:** 명시적인 `tenantId: null` 거절과 `tenantScope: 'global'` 사용을 구분했다. Prisma 7 adapter가 필요한 `pg`와 Outbox 알림 기능의 optional `pg`를 구분했다.
- **R06:** PostgreSQL 전용이며 16이 검증 기준임을 명시했다. 설치 → SQL → 초기화 → 성공 확인 순서로 재구성하고, 모든 코드와 데이터베이스 설정을 포함한 13개 파일의 quick-start를 추가했다. receipt와 side effect를 같은 DB transaction에서 기록하는 예제다.
- **R07:** README 목차와 짧은 시작 절차를 두고 상세 운영/API 계약을 `docs/usage.md`로 분리했다. SQL 전체 복제를 제거했으며 공개 0.3.0, 과거 변경 이력, 이번 Unreleased 계약을 구분했다.
- **R08:** Kafka 예제에 event ID, tenant, routing/tracing/idempotency metadata를 보존했다. 대소문자와 관계없이 custom `outbox-*` headers를 제거하므로 canonical 값이 null일 때도 위조된 값이 남지 않는다. 소비자 dedupe는 애플리케이션 책임이다.
- **R09:** README, usage, quick-start README, `llms.txt`를 tarball에 포함하고 설치된 파일만 따라갈 수 있게 연결했다. 실제 tarball의 로컬 링크·앵커 65개가 정상이며, 내부 감사/계획/개발용 문서는 포함하지 않는다.
- **R10:** 패키지 description/keywords/homepage와 README 제목을 수정했다. GitHub `nestarc/outbox`의 설명, Outbox 전용 homepage 및 8개 topics를 적용 후 재조회로 확인했다. npm 메타데이터 변경은 다음 발행 때 반영된다.
- **R11:** 공식 사이트 원본 저장소의 `codex/outbox-docs-audit` 브랜치에 문서 8개를 수정/추가했다. published 0.3.0 문서는 그 버전의 제한을 설명하며 미배포 변경을 이미 제공하는 것처럼 표시하지 않는다. 별도 clone에서 검증한 파일과 원본 적용 파일이 바이트 단위로 일치한다.

- **R12:** 단위/coverage와 실제 PostgreSQL E2E, 동일 tarball을 사용한 strict 소비자와 README/완결 예제, 문서 경로 및 정책 검증을 완료했다.

### 실행한 검증

환경: macOS arm64, Node 24.11.1, npm 11.6.2, 전용 PostgreSQL 16. 로컬에서 Node 22까지 재실행했다는 의미는 아니다.

| 검증                                                                         | 결과                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`, `npm run build`                                              | 통과                                                                                                                          |
| `npm run test:cov -- --runInBand`                                            | 11 suites / 272 tests 통과, 필수 파일별 coverage gate 통과                                                                    |
| `npm run test:e2e`                                                           | 실제 PostgreSQL 41 tests 통과                                                                                                 |
| `npm run test:compatibility-policy`                                          | 통과                                                                                                                          |
| `npm run test:workflow-policy`                                               | 20 immutable action references 검사 통과                                                                                      |
| `node scripts/release-artifact.js pack /private/tmp/outbox-readme-candidate` | 149 files / 82,744 bytes, 문서 포함·경로 검사 통과                                                                            |
| `node scripts/test-package-exports.js`                                       | 동일 tarball의 root/types/SQL export, optional pg 없는 설치 통과                                                              |
| `node scripts/test-modern-consumer.js --nest12`                              | 동일 tarball, Nest 12.0.1 / Schedule 12.0.1 / Prisma 7.10.0, strict install/typecheck/build/PostgreSQL smoke 통과             |
| `node scripts/test-packed-examples.js`                                       | 동일 tarball의 pg 없음/있음 README 예제, quick-start 전체 설치·SQL·DI·전달·durable dedupe 통과                                |
| 문서 링크 및 앵커                                                            | 소스 66개, 실제 tarball 65개 통과; 패키지 문서와 최신 소스 일치                                                               |
| Prettier / `git diff --check`                                                | 통과                                                                                                                          |
| 공식 사이트 검증                                                             | catalog 78 tests, doc contracts 20 tests, catalog/API validation, VitePress build, 193 public pages / 194 HTML 문서 검증 통과 |

tarball 검사는 같은 `/private/tmp/outbox-readme-candidate/package.tgz`와 `metadata.json`을 `OUTBOX_TGZ` / `OUTBOX_TGZ_METADATA`로 전달했다. DB 검사는 이 작업에서 생성한 전용 PostgreSQL endpoint `127.0.0.1:5433/outbox_test`만 사용했다.

검증 artifact SHA-512:

```text
f7LOY/c5efLt0bGPgkM+QQKugUY7bw61y2ij4HUUManyiEXU7ODWHNmyWZ88rFdKIrom3hHDQP+2zmPQpJvuSw==
```

### 외부 적용과 미배포 상태

- Outbox: `codex/readme-audit-improvements`, 기존 `aa0e55d4c5e68e9d7a2a95d828039ed9851a2c27` 커밋 보존. 코드와 문서 변경은 작업 트리에 있다.
- GitHub 저장소 설명·homepage·topics는 실제 반영되었다. 검색 순위나 재색인 완료를 검증한 것은 아니다.
- 공식 사이트: `/Users/ksy/Documents/GitHub/nestarc.dev`, `codex/outbox-docs-audit`, 기준 HEAD `a9aeb64a2328e599bea4e4d709ff3486cd36e2bf`. 수정 7개와 신규 `packages/outbox/agent-guide.md` 1개가 작업 트리에 있다.
- 공식 사이트의 기존 현재 소스는 이미 0.3.0을 가리켰고 해당 HEAD의 Build/Cloudflare 배포 성공을 확인했다. 검색 결과의 이전 0.2 표시는 현재 배포가 0.2라는 근거로 사용하지 않았다. 이번 수정분은 아직 배포되지 않았다.
- 이번 작업에서 commit, push, main 병합, npm 발행, 사이트 신규 배포는 실행하지 않았다. 버전은 0.3.0으로 유지하고 사용자에게 보이는 동작 변경은 Unreleased에 기록했다.
- 검증 완료 후 `docker compose -p outbox-readme-audit down`으로 이 작업의 전용 PostgreSQL 컨테이너와 네트워크를 제거했다.
