CREATE TABLE IF NOT EXISTS quick_start_orders (
  id UUID PRIMARY KEY,
  total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_start_processed_events (
  "eventId" UUID PRIMARY KEY,
  "processedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quick_start_order_confirmations (
  id UUID PRIMARY KEY,
  "orderId" UUID NOT NULL,
  "eventId" UUID NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
