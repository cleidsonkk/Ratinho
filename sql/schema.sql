CREATE TABLE IF NOT EXISTS validation_jobs (
  id uuid PRIMARY KEY,
  external_message_id text,
  channel text NOT NULL DEFAULT 'whatsapp',
  phone text NOT NULL,
  original_message text NOT NULL,
  ticket_code text,
  status text NOT NULL DEFAULT 'queued',
  confirmed boolean NOT NULL DEFAULT false,
  confirmation_code text,
  customer_message text,
  error_message text,
  screenshot_sha256 text,
  screenshot_bytes integer,
  text_sent boolean NOT NULL DEFAULT false,
  image_sent boolean NOT NULL DEFAULT false,
  delivery_error text,
  raw_payload jsonb,
  result_payload jsonb,
  ticket_amount numeric(12,2),
  ticket_prize numeric(12,2),
  ticket_game_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE validation_jobs
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

ALTER TABLE validation_jobs
  ADD COLUMN IF NOT EXISTS ticket_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS ticket_prize numeric(12,2),
  ADD COLUMN IF NOT EXISTS ticket_game_count integer;

DROP INDEX IF EXISTS validation_jobs_external_message_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_external_message_id_idx
  ON validation_jobs (channel, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS validation_jobs_phone_created_at_idx
  ON validation_jobs (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS validation_jobs_ticket_code_idx
  ON validation_jobs (ticket_code);

CREATE INDEX IF NOT EXISTS validation_jobs_status_idx
  ON validation_jobs (status);

CREATE INDEX IF NOT EXISTS validation_jobs_created_at_idx
  ON validation_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS customer_credit_accounts (
  channel text NOT NULL,
  phone text NOT NULL,
  customer_name text,
  credit_limit numeric(12,2),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, phone)
);

CREATE TABLE IF NOT EXISTS customer_credit_payments (
  id uuid PRIMARY KEY,
  channel text NOT NULL,
  phone text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_credit_payments_customer_created_at_idx
  ON customer_credit_payments (channel, phone, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_credit_reservations (
  job_id uuid PRIMARY KEY REFERENCES validation_jobs(id) ON DELETE CASCADE,
  channel text NOT NULL,
  phone text NOT NULL,
  ticket_code text,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_credit_reservations_customer_status_idx
  ON customer_credit_reservations (channel, phone, status, expires_at);

CREATE TABLE IF NOT EXISTS customer_profiles (
  channel text NOT NULL,
  recipient_id text NOT NULL,
  display_name text,
  username text,
  first_name text,
  last_name text,
  phone_number text,
  raw_contact jsonb,
  contact_shared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, recipient_id)
);

CREATE INDEX IF NOT EXISTS customer_profiles_phone_number_idx
  ON customer_profiles (phone_number)
  WHERE phone_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS security_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_created_at_idx
  ON security_events (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notification_targets (
  channel text NOT NULL DEFAULT 'telegram',
  target_id text NOT NULL,
  display_name text,
  username text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  PRIMARY KEY (channel, target_id)
);

CREATE INDEX IF NOT EXISTS admin_notification_targets_enabled_idx
  ON admin_notification_targets (channel, enabled, updated_at DESC);
