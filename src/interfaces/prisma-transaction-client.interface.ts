/** Minimal type for Prisma interactive transaction client (inside $transaction callback). */
export type PrismaTransactionClient = {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

/** Minimal type for PrismaService instance (used by OutboxPoller for polling queries). */
export type PrismaLike = PrismaTransactionClient & {
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<number>;
};
