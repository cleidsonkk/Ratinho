import { createHash, randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";
import type { TicketConfirmationResult, ValidationJob } from "../types.js";
import { extractTicketFinancials } from "./credit.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

function getSql(): NeonQueryFunction<false, false> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL não configurada");
  }

  if (!sqlClient) {
    sqlClient = neon(config.databaseUrl);
  }

  return sqlClient;
}

export function hasDatabase(): boolean {
  return Boolean(config.databaseUrl);
}

export async function createValidationJob(input: {
  channel: ValidationJob["channel"];
  recipientId: string;
  mensagem: string;
  codigo: string;
  externalMessageId: string | null;
  raw: unknown;
}): Promise<{ job: ValidationJob; duplicate: boolean }> {
  const sql = getSql();

  if (input.externalMessageId) {
    const existing = await sql`
      SELECT id, external_message_id, channel, phone, original_message, ticket_code, raw_payload, created_at
      FROM validation_jobs
      WHERE channel = ${input.channel}
        AND external_message_id = ${input.externalMessageId}
      LIMIT 1
    `;

    if (existing.length > 0) {
      const row = existing[0] as Record<string, any>;
      return {
        duplicate: true,
        job: {
          id: row.id,
          externalMessageId: row.external_message_id,
          channel: row.channel,
          recipientId: row.phone,
          numero: row.phone,
          mensagem: row.original_message,
          codigo: row.ticket_code,
          raw: row.raw_payload,
          createdAt: new Date(row.created_at).toISOString()
        }
      };
    }
  }

  const id = randomUUID();
  await sql`
    INSERT INTO validation_jobs (
      id,
      external_message_id,
      channel,
      phone,
      original_message,
      ticket_code,
      status,
      raw_payload
    )
    VALUES (
      ${id},
      ${input.externalMessageId},
      ${input.channel},
      ${input.recipientId},
      ${input.mensagem},
      ${input.codigo},
      'queued',
      ${JSON.stringify(input.raw)}::jsonb
    )
  `;

  return {
    duplicate: false,
    job: {
      id,
      externalMessageId: input.externalMessageId,
      channel: input.channel,
      recipientId: input.recipientId,
      numero: input.recipientId,
      mensagem: input.mensagem,
      codigo: input.codigo,
      raw: input.raw,
      createdAt: new Date().toISOString()
    }
  };
}

export async function recordExtractionFailure(input: {
  channel: ValidationJob["channel"];
  recipientId: string;
  mensagem: string;
  externalMessageId: string | null;
  raw: unknown;
}): Promise<void> {
  if (!hasDatabase()) {
    return;
  }

  const sql = getSql();
  await sql`
    INSERT INTO validation_jobs (
      id,
      external_message_id,
      channel,
      phone,
      original_message,
      ticket_code,
      status,
      raw_payload,
      processed_at
    )
    VALUES (
      ${randomUUID()},
      ${input.externalMessageId},
      ${input.channel},
      ${input.recipientId},
      ${input.mensagem},
      ${null},
      'codigo_nao_encontrado',
      ${JSON.stringify(input.raw)}::jsonb,
      now()
    )
    ON CONFLICT (channel, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
  `;
}

export async function markJobProcessing(jobId: string): Promise<void> {
  if (!hasDatabase()) {
    return;
  }

  const sql = getSql();
  await sql`
    UPDATE validation_jobs
    SET status = 'processing', updated_at = now()
    WHERE id = ${jobId}
  `;
}

export async function markJobFinished(jobId: string, result: TicketConfirmationResult, customerMessage: string): Promise<void> {
  if (!hasDatabase()) {
    return;
  }

  const sql = getSql();
  const screenshotBytes = result.screenshot_base64 ? Buffer.byteLength(result.screenshot_base64, "base64") : null;
  const screenshotSha256 = result.screenshot_base64
    ? createHash("sha256").update(Buffer.from(result.screenshot_base64, "base64")).digest("hex")
    : null;
  const persistedStatus = result.confirmado ? "confirmado" : result.status;
  const financials = extractTicketFinancials(result.dados_bilhete);
  const resultPayload = {
    ...result,
    screenshot_base64: result.screenshot_base64 ? "[omitted]" : null
  };

  await sql`
    UPDATE validation_jobs
    SET
      status = ${persistedStatus},
      confirmed = ${result.confirmado},
      confirmation_code = ${result.codigo_confirmacao},
      customer_message = ${customerMessage},
      error_message = ${result.mensagem_erro},
      screenshot_sha256 = ${screenshotSha256},
      screenshot_bytes = ${screenshotBytes},
      ticket_amount = ${financials.amount || null},
      ticket_prize = ${financials.prize || null},
      ticket_game_count = ${financials.gameCount || null},
      result_payload = ${JSON.stringify(resultPayload)}::jsonb,
      updated_at = now(),
      processed_at = now()
    WHERE id = ${jobId}
  `;
}

export async function markDeliveryStatus(input: {
  jobId: string;
  textSent: boolean;
  imageSent: boolean;
  deliveryError: string | null;
}): Promise<void> {
  if (!hasDatabase()) {
    return;
  }

  const sql = getSql();
  await sql`
    UPDATE validation_jobs
    SET
      text_sent = ${input.textSent},
      image_sent = ${input.imageSent},
      delivery_error = ${input.deliveryError},
      updated_at = now()
    WHERE id = ${input.jobId}
  `;
}

export async function recordSecurityEvent(input: {
  id: string;
  eventType: string;
  ip: string;
  userAgent: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!hasDatabase()) {
    return;
  }

  const sql = getSql();
  await sql`
    INSERT INTO security_events (id, event_type, ip, user_agent, metadata)
    VALUES (${input.id}, ${input.eventType}, ${input.ip}, ${input.userAgent}, ${JSON.stringify(input.metadata)}::jsonb)
  `;
}
