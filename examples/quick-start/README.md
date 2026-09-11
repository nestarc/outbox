# Runnable NestJS + Prisma outbox example

This complete application creates an order and its outbox event in one
PostgreSQL transaction. A local handler then records a confirmation and a dedupe
receipt in a second transaction. It sends no email and connects to no broker.
The application waits for `SENT`, replays the consumer operation, checks that
only one confirmation exists, prints the result, and closes cleanly.

This example is included in 0.4.0 and pins `@nestarc/outbox` to 0.4.0. The
dependency is installed from npm by default, while repository checks substitute
the candidate tarball. Before 0.4.0 is published, use the local package
instructions below.

## Requirements

- Node 22 or 24, npm, and Docker Compose.
- The pinned example uses Nest 11.2.3, Schedule 5.0.1, and Prisma 5.22.0.
  Prisma 5 uses its native engine, so this example does not need `pg`.
- A fresh, dedicated PostgreSQL database. The included Compose configuration
  binds PostgreSQL 16 to `127.0.0.1:5434` and keeps its data in temporary storage.

## Copy and run

From an application that has installed the `@nestarc/outbox` 0.4.0 tarball
containing this directory, copy the complete example before installing its
dependencies:

```bash
cp -R node_modules/@nestarc/outbox/examples/quick-start ./outbox-quick-start
cd outbox-quick-start
```

Alternatively, after cloning the repository, run `cd examples/quick-start`.
The following commands run **inside the copied example directory**:

```bash
npm install --strict-peer-deps
docker compose -p outbox-quick-start up -d --wait
export DATABASE_URL='postgresql://example:example@127.0.0.1:5434/outbox_quick_start'
npm run prisma:generate
npm run db:prepare
npm run typecheck
npm run build
npm start
```

To try local package changes or run before 0.4.0 is published, build and pack
from the repository root with `npm run build` and `npm pack`. In the example
directory, replace `npm install --strict-peer-deps` above with
`npm install --strict-peer-deps /absolute/path/to/nestarc-outbox-0.4.0.tgz`,
then continue with the database and application setup commands.

`db:prepare` executes the application-owned SQL and the package's public
`create-outbox-table.sql` asset using Prisma CLI. It does not require `psql`.
The outbox table is deliberately absent from `schema.prisma`; avoid `prisma db
push` against this example because schema synchronization can propose dropping
the unmanaged outbox table. For an existing outbox deployment, follow the
package's upgrade instructions instead of using this fresh-database example.

Successful output has fresh UUIDs and these stable values:

```json
{
  "orderId": "<generated UUID>",
  "eventId": "<generated UUID>",
  "status": "SENT",
  "confirmations": 1,
  "duplicateReplay": "ignored"
}
```

Run `npm start` again to create another order. Existing rows remain available
until you stop the disposable database:

```bash
docker compose -p outbox-quick-start down
```

## Adapt it to your application

- `src/prisma.module.ts` exports a global Prisma service for synchronous module
  registration. `src/app.module.ts` registers the listener as a Nest provider.
- `src/order.service.ts` supplies the same transaction to the business write
  and `outbox.emit()`. Let failures escape that transaction callback.
- `src/order-confirmation.listener.ts` uses `context.eventId` as a durable
  consumer key. Its receipt and database side effect commit together. Each
  independent consumer needs its own receipt namespace (table or compound key).
- This package delivers **at least once**. Storing `idempotencyKey` metadata does
  not automatically deduplicate anything. External email or broker calls cannot
  share the demonstrated database transaction: use a provider's durable
  idempotency mechanism or design a separate durable delivery workflow.
- `src/main.ts` enables Nest shutdown hooks for signals and drains the module
  before disconnecting Prisma during normal completion.

The repository's `npm run test:packed-examples` command copies this example from
an installed tarball into an isolated consumer and runs the same setup and
application commands against its disposable PostgreSQL fixture. That test
command belongs to the package repository, not to this example or your app.
