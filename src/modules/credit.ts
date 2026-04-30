import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";
import type { CreditCheckDecision, CreditSnapshot, ValidationJob } from "../types.js";
import { nullableMoneyAmount, toMoneyAmount } from "./money.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

type CreditRow = Record<string, any>;

type CustomerKey = {
  channel: ValidationJob["channel"] | string;
  phone: string;
};

export type TicketFinancials = {
  amount: number;
  prize: number;
  gameCount: number;
};

export type CreditReserveInput = CustomerKey & {
  jobId: string;
  ticketCode: string;
  ticketAmount: number;
};

export type CustomerCreditSummary = CreditSnapshot;

function getSql(): NeonQueryFunction<false, false> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  if (!sqlClient) {
    sqlClient = neon(config.databaseUrl);
  }

  return sqlClient;
}

function money(value: unknown): number {
  return toMoneyAmount(value);
}

function nullableMoney(value: unknown): number | null {
  return nullableMoneyAmount(value);
}

function defaultCreditLimit(): number {
  return money(config.customerDefaultCreditLimit);
}

export function requiredPaymentForTicket(credit: Pick<CustomerCreditSummary, "limit" | "outstanding" | "ticketAmount">): number {
  if (credit.limit === null || credit.ticketAmount === undefined) {
    return 0;
  }

  return money(Math.max(0, credit.outstanding + credit.ticketAmount - credit.limit));
}

export function applyConfirmedTicketToCredit(credit: CustomerCreditSummary): CustomerCreditSummary {
  const ticketAmount = money(credit.ticketAmount);

  if (ticketAmount <= 0) {
    return credit;
  }

  const used = money(credit.used + ticketAmount);
  const outstanding = money(credit.outstanding + ticketAmount);
  const available = credit.limit === null ? null : money(Math.max(0, credit.limit - outstanding));

  return {
    ...credit,
    used,
    outstanding,
    available,
    requiredPayment: 0
  };
}

export function applyPaymentToCredit(credit: CustomerCreditSummary, paymentAmount: number): CustomerCreditSummary {
  const payment = money(paymentAmount);

  if (payment <= 0) {
    return credit;
  }

  const payments = money(credit.payments + payment);
  const outstanding = money(Math.max(0, credit.outstanding - payment));
  const available = credit.limit === null ? null : money(Math.max(0, credit.limit - outstanding));

  return {
    ...credit,
    payments,
    outstanding,
    available,
    requiredPayment: credit.ticketAmount === undefined
      ? undefined
      : requiredPaymentForTicket({ limit: credit.limit, outstanding, ticketAmount: credit.ticketAmount })
  };
}

function rowToCreditSummary(row: CreditRow | undefined, ticketAmount?: number): CustomerCreditSummary {
  const limited = true;
  const limit = nullableMoney(row?.credit_limit) ?? defaultCreditLimit();
  const used = money(row?.used_amount);
  const payments = money(row?.payment_amount);
  const reserved = money(row?.reserved_amount);
  const outstanding = money(row?.outstanding_amount);
  const available = row?.available_amount === null || row?.available_amount === undefined
    ? Math.max(0, limit - outstanding)
    : Math.max(0, money(row.available_amount));

  const summary: CustomerCreditSummary = {
    limited,
    limit,
    used,
    payments,
    reserved,
    outstanding,
    available,
    ticketAmount
  };

  if (ticketAmount !== undefined) {
    summary.requiredPayment = requiredPaymentForTicket(summary);
  }

  return summary;
}

function emptySummary(): CustomerCreditSummary {
  const limit = defaultCreditLimit();

  return {
    limited: true,
    limit,
    used: 0,
    payments: 0,
    reserved: 0,
    outstanding: 0,
    available: limit
  };
}

function dataRoot(data: Record<string, unknown> | null): Record<string, any> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const payload = data as Record<string, any>;
  const nested = payload.dados_bilhete;
  return nested && typeof nested === "object" ? nested as Record<string, any> : payload;
}

export function extractTicketFinancials(data: Record<string, unknown> | null): TicketFinancials {
  const payload = dataRoot(data);
  const aposta = payload.aposta && typeof payload.aposta === "object" ? payload.aposta as Record<string, any> : {};
  const itens = Array.isArray(payload.itens)
    ? payload.itens
    : Array.isArray(payload.itensBolao)
      ? payload.itensBolao
      : [];

  return {
    amount: money(aposta.vl_aposta ?? aposta.valor ?? aposta.amount),
    prize: money(aposta.vl_premio ?? aposta.premio ?? aposta.prize),
    gameCount: itens.length
  };
}

export function parseMoneyInput(value: unknown): number | null {
  return nullableMoney(value);
}

export function formatMoney(value: number | null): string {
  if (value === null) {
    return "sem limite definido";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

export async function getCustomerCreditSummary(channel: string, phone: string): Promise<CustomerCreditSummary> {
  if (!config.databaseUrl) {
    return emptySummary();
  }

  const sql = getSql();
  const defaultLimit = defaultCreditLimit();
  const rows = await sql.query(`
    WITH input AS (
      SELECT $1::text AS channel, $2::text AS phone, $3::numeric AS default_limit
    ),
    account AS (
      SELECT a.credit_limit
      FROM customer_credit_accounts a
      JOIN input i ON i.channel = a.channel AND i.phone = a.phone
      LIMIT 1
    ),
    confirmed AS (
      SELECT COALESCE(SUM(v.ticket_amount), 0) AS used_amount
      FROM validation_jobs v
      JOIN input i ON i.channel = v.channel AND i.phone = v.phone
      WHERE v.confirmed = true
        AND v.ticket_amount IS NOT NULL
    ),
    payments AS (
      SELECT COALESCE(SUM(p.amount), 0) AS payment_amount
      FROM customer_credit_payments p
      JOIN input i ON i.channel = p.channel AND i.phone = p.phone
    ),
    reserved AS (
      SELECT COALESCE(SUM(r.amount), 0) AS reserved_amount
      FROM customer_credit_reservations r
      JOIN input i ON i.channel = r.channel AND i.phone = r.phone
      WHERE r.status = 'active'
        AND r.expires_at > now()
    )
    SELECT
      true AS limited,
      COALESCE((SELECT credit_limit FROM account LIMIT 1), (SELECT default_limit FROM input)) AS credit_limit,
      (SELECT used_amount FROM confirmed) AS used_amount,
      (SELECT payment_amount FROM payments) AS payment_amount,
      (SELECT reserved_amount FROM reserved) AS reserved_amount,
      GREATEST((SELECT used_amount FROM confirmed) - (SELECT payment_amount FROM payments) + (SELECT reserved_amount FROM reserved), 0) AS outstanding_amount,
      GREATEST(
        COALESCE((SELECT credit_limit FROM account LIMIT 1), (SELECT default_limit FROM input))
        - GREATEST((SELECT used_amount FROM confirmed) - (SELECT payment_amount FROM payments) + (SELECT reserved_amount FROM reserved), 0),
        0
      ) AS available_amount
  `, [channel, phone, defaultLimit]);

  return rowToCreditSummary(rows[0]);
}

export async function loadCustomerCreditSummaries(keys: CustomerKey[]): Promise<Map<string, CustomerCreditSummary>> {
  const summaries = new Map<string, CustomerCreditSummary>();

  if (!config.databaseUrl || keys.length === 0) {
    return summaries;
  }

  const channels = keys.map((key) => key.channel);
  const phones = keys.map((key) => key.phone);
  const defaultLimit = defaultCreditLimit();
  const sql = getSql();
  const rows = await sql.query(`
    WITH keys AS (
      SELECT *
      FROM unnest($1::text[], $2::text[]) AS k(channel, phone)
    ),
    confirmed AS (
      SELECT v.channel, v.phone, COALESCE(SUM(v.ticket_amount), 0) AS used_amount
      FROM validation_jobs v
      JOIN keys k ON k.channel = v.channel AND k.phone = v.phone
      WHERE v.confirmed = true
        AND v.ticket_amount IS NOT NULL
      GROUP BY v.channel, v.phone
    ),
    payments AS (
      SELECT p.channel, p.phone, COALESCE(SUM(p.amount), 0) AS payment_amount
      FROM customer_credit_payments p
      JOIN keys k ON k.channel = p.channel AND k.phone = p.phone
      GROUP BY p.channel, p.phone
    ),
    reserved AS (
      SELECT r.channel, r.phone, COALESCE(SUM(r.amount), 0) AS reserved_amount
      FROM customer_credit_reservations r
      JOIN keys k ON k.channel = r.channel AND k.phone = r.phone
      WHERE r.status = 'active'
        AND r.expires_at > now()
      GROUP BY r.channel, r.phone
    )
    SELECT
      k.channel,
      k.phone,
      a.credit_limit IS NOT NULL AS limited,
      COALESCE(a.credit_limit, $3::numeric) AS credit_limit,
      COALESCE(c.used_amount, 0) AS used_amount,
      COALESCE(p.payment_amount, 0) AS payment_amount,
      COALESCE(r.reserved_amount, 0) AS reserved_amount,
      GREATEST(COALESCE(c.used_amount, 0) - COALESCE(p.payment_amount, 0) + COALESCE(r.reserved_amount, 0), 0) AS outstanding_amount,
      GREATEST(COALESCE(a.credit_limit, $3::numeric) - GREATEST(COALESCE(c.used_amount, 0) - COALESCE(p.payment_amount, 0) + COALESCE(r.reserved_amount, 0), 0), 0) AS available_amount
    FROM keys k
    LEFT JOIN customer_credit_accounts a ON a.channel = k.channel AND a.phone = k.phone
    LEFT JOIN confirmed c ON c.channel = k.channel AND c.phone = k.phone
    LEFT JOIN payments p ON p.channel = k.channel AND p.phone = k.phone
    LEFT JOIN reserved r ON r.channel = k.channel AND r.phone = k.phone
  `, [channels, phones, defaultLimit]);

  for (const row of rows as CreditRow[]) {
    summaries.set(`${row.channel}:${row.phone}`, rowToCreditSummary(row));
  }

  return summaries;
}

export async function reserveCustomerCredit(input: CreditReserveInput): Promise<CreditCheckDecision> {
  if (!config.databaseUrl) {
    return { allowed: true };
  }

  const ticketAmount = money(input.ticketAmount);
  const existingSummary = await getCustomerCreditSummary(input.channel, input.phone);

  if (ticketAmount <= 0) {
    return {
      allowed: false,
      message: "Nao foi possivel ler o valor do bilhete para validar o limite do cliente.",
      credit: { ...existingSummary, ticketAmount }
    };
  }

  const sql = getSql();
  const defaultLimit = defaultCreditLimit();
  const rows = await sql.query(`
    WITH input AS (
      SELECT
        $1::uuid AS job_id,
        $2::text AS channel,
        $3::text AS phone,
        $4::text AS ticket_code,
        $5::numeric AS amount,
        $6::numeric AS default_limit
    ),
    account AS (
      SELECT a.credit_limit
      FROM customer_credit_accounts a
      JOIN input i ON i.channel = a.channel AND i.phone = a.phone
      LIMIT 1
    ),
    confirmed AS (
      SELECT COALESCE(SUM(v.ticket_amount), 0) AS used_amount
      FROM validation_jobs v
      JOIN input i ON i.channel = v.channel AND i.phone = v.phone
      WHERE v.confirmed = true
        AND v.ticket_amount IS NOT NULL
    ),
    payments AS (
      SELECT COALESCE(SUM(p.amount), 0) AS payment_amount
      FROM customer_credit_payments p
      JOIN input i ON i.channel = p.channel AND i.phone = p.phone
    ),
    reserved AS (
      SELECT COALESCE(SUM(r.amount), 0) AS reserved_amount
      FROM customer_credit_reservations r
      JOIN input i ON i.channel = r.channel AND i.phone = r.phone
      WHERE r.status = 'active'
        AND r.expires_at > now()
        AND r.job_id <> i.job_id
    ),
    decision AS (
      SELECT
        true AS limited,
        COALESCE((SELECT credit_limit FROM account LIMIT 1), (SELECT default_limit FROM input)) AS credit_limit,
        (SELECT used_amount FROM confirmed) AS used_amount,
        (SELECT payment_amount FROM payments) AS payment_amount,
        (SELECT reserved_amount FROM reserved) AS reserved_amount,
        GREATEST((SELECT used_amount FROM confirmed) - (SELECT payment_amount FROM payments) + (SELECT reserved_amount FROM reserved), 0) AS outstanding_amount,
        GREATEST(
          COALESCE((SELECT credit_limit FROM account LIMIT 1), (SELECT default_limit FROM input))
          - GREATEST((SELECT used_amount FROM confirmed) - (SELECT payment_amount FROM payments) + (SELECT reserved_amount FROM reserved), 0),
          0
        ) AS available_amount,
        (SELECT amount FROM input) AS ticket_amount
    ),
    allowed AS (
      SELECT
        *,
        CASE
          WHEN ticket_amount <= available_amount THEN true
          ELSE false
        END AS allowed
      FROM decision
    ),
    inserted AS (
      INSERT INTO customer_credit_reservations (job_id, channel, phone, ticket_code, amount, status, expires_at)
      SELECT i.job_id, i.channel, i.phone, i.ticket_code, i.amount, 'active', now() + interval '30 minutes'
      FROM input i
      CROSS JOIN allowed a
      WHERE a.allowed = true
      ON CONFLICT (job_id) DO UPDATE SET
        channel = EXCLUDED.channel,
        phone = EXCLUDED.phone,
        ticket_code = EXCLUDED.ticket_code,
        amount = EXCLUDED.amount,
        status = 'active',
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
      RETURNING job_id
    )
    SELECT
      allowed.*,
      EXISTS (SELECT 1 FROM inserted) AS reservation_created
    FROM allowed
  `, [input.jobId, input.channel, input.phone, input.ticketCode, ticketAmount, defaultLimit]);

  const row = rows[0] as CreditRow | undefined;
  const summary = rowToCreditSummary(row, ticketAmount);

  if (row?.allowed) {
    return { allowed: true, credit: summary };
  }

  return {
    allowed: false,
    message: "Limite do cliente excedido.",
    credit: summary
  };
}

export async function releaseCustomerCreditReservation(jobId: string): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  await getSql()`
    UPDATE customer_credit_reservations
    SET status = 'released', updated_at = now()
    WHERE job_id = ${jobId}
      AND status = 'active'
  `;
}

export async function commitCustomerCreditReservation(jobId: string): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  await getSql()`
    UPDATE customer_credit_reservations
    SET status = 'committed', updated_at = now()
    WHERE job_id = ${jobId}
      AND status = 'active'
  `;
}

export async function setCustomerCreditLimit(input: CustomerKey & {
  customerName: string;
  creditLimit: number | null;
  note: string | null;
}): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  await getSql()`
    INSERT INTO customer_credit_accounts (channel, phone, customer_name, credit_limit, note)
    VALUES (${input.channel}, ${input.phone}, ${input.customerName}, ${input.creditLimit}, ${input.note})
    ON CONFLICT (channel, phone) DO UPDATE SET
      customer_name = EXCLUDED.customer_name,
      credit_limit = EXCLUDED.credit_limit,
      note = EXCLUDED.note,
      updated_at = now()
  `;
}

export async function recordCustomerCreditPayment(input: CustomerKey & {
  customerName: string;
  amount: number;
  note: string | null;
}): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  const amount = money(input.amount);

  if (amount <= 0) {
    return;
  }

  await getSql().transaction((tx) => [
    tx`
      INSERT INTO customer_credit_accounts (channel, phone, customer_name)
      VALUES (${input.channel}, ${input.phone}, ${input.customerName})
      ON CONFLICT (channel, phone) DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        updated_at = now()
    `,
    tx`
      INSERT INTO customer_credit_payments (id, channel, phone, amount, note)
      VALUES (${randomUUID()}, ${input.channel}, ${input.phone}, ${amount}, ${input.note})
    `
  ]);
}
