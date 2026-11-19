-- Pedidos (antes em data/orders.json). Cada pedido guarda os dados do cliente.
CREATE TABLE IF NOT EXISTS orders (
  order_id       TEXT PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,
  access_token   TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  whatsapp       TEXT NOT NULL,
  product        TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  method         TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  paid_at        TEXT,
  shipped_at     TEXT,
  transaction_id TEXT,
  history        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at);

-- Sessões do admin (antes em memória no processo Node).
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Rate limit por IP (antes em memória no processo Node).
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_hits_key_at ON rate_hits (key, at);
