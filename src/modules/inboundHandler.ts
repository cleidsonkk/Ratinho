import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { InboundMessage, ValidationJob } from "../types.js";
import { handleAdminNotificationCommand } from "./adminNotificationCommand.js";
import { notifyAdminContactUpdate, notifyAdminExtractionFailure, notifyAdminSafely } from "./adminNotifier.js";
import { getCustomerCreditSummary } from "./credit.js";
import { formatPhoneNumber, isTelegramContactMessage, upsertCustomerProfileFromInbound, upsertTelegramContact } from "./customerProfile.js";
import {
  buildExtractionFailureMessage,
  buildMultipleCodesMessage,
  buildTelegramContactRegisteredMessage,
  buildTelegramContactRejectedMessage,
  buildTelegramWelcomeMessage
} from "./messageBuilder.js";
import { requestTelegramContact, sendText } from "./notifier.js";
import { createValidationJob, hasDatabase, recordExtractionFailure } from "./persistence.js";
import { extractTicketCode, extractTicketCodes } from "./ticketExtractor.js";

export type InboundHandleResult =
  | { kind: "ignored"; reason: string }
  | { kind: "no_code" }
  | { kind: "queued"; job: ValidationJob; duplicate: boolean };

export async function prepareInboundForProcessing(inbound: InboundMessage): Promise<InboundHandleResult> {
  if (inbound.mensagem.length > config.maxMessageLength) {
    return { kind: "ignored", reason: "mensagem_muito_longa" };
  }

  if (await handleAdminNotificationCommand(inbound)) {
    return { kind: "ignored", reason: "admin_notification_command" };
  }

  await upsertCustomerProfileFromInbound(inbound).catch((error) => {
    log("warn", "Falha ao atualizar perfil do cliente", {
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  if (isTelegramContactMessage(inbound)) {
    const result = await upsertTelegramContact(inbound);

    if (result.stored) {
      await sendText(inbound.channel, inbound.recipientId, buildTelegramContactRegisteredMessage(formatPhoneNumber(result.phoneNumber) ?? result.phoneNumber));
      await notifyAdminSafely(notifyAdminContactUpdate(inbound, true, result.phoneNumber), {
        channel: inbound.channel,
        recipientId: inbound.recipientId,
        reason: "telegram_contact_registered"
      });
    } else {
      await sendText(inbound.channel, inbound.recipientId, buildTelegramContactRejectedMessage());
      await notifyAdminSafely(notifyAdminContactUpdate(inbound, false, inbound.contactPhone ?? null), {
        channel: inbound.channel,
        recipientId: inbound.recipientId,
        reason: "telegram_contact_rejected"
      });
    }

    return { kind: "ignored", reason: "telegram_contact" };
  }

  const codes = extractTicketCodes(inbound.mensagem);

  if (codes.length > 1) {
    const summary = hasDatabase()
      ? await getCustomerCreditSummary(inbound.channel, inbound.recipientId).catch(() => null)
      : null;

    await sendText(inbound.channel, inbound.recipientId, buildMultipleCodesMessage(summary));
    await notifyAdminSafely(notifyAdminExtractionFailure(inbound, "multiplos_codigos"), {
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      reason: "multiplos_codigos"
    });
    return { kind: "ignored", reason: "multiplos_codigos" };
  }

  const extraction = extractTicketCode(inbound.mensagem);

  if (!extraction.codigo_encontrado || !extraction.codigo) {
    if (inbound.channel === "telegram" && /^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(inbound.mensagem.trim())) {
      await requestTelegramContact(inbound.recipientId, buildTelegramWelcomeMessage());
      return { kind: "ignored", reason: "telegram_command" };
    }

    await sendText(inbound.channel, inbound.recipientId, buildExtractionFailureMessage());
    await recordExtractionFailure({
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      mensagem: inbound.mensagem,
      externalMessageId: inbound.externalMessageId,
      raw: inbound.raw
    });
    await notifyAdminSafely(notifyAdminExtractionFailure(inbound, "codigo_invalido"), {
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      reason: "codigo_invalido"
    });

    return { kind: "no_code" };
  }

  if (!hasDatabase()) {
    const job: ValidationJob = {
      id: randomUUID(),
      externalMessageId: inbound.externalMessageId,
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      numero: inbound.recipientId,
      mensagem: inbound.mensagem,
      codigo: extraction.codigo,
      raw: inbound.raw,
      createdAt: new Date().toISOString()
    };

    return { kind: "queued", job, duplicate: false };
  }

  const created = await createValidationJob({
    channel: inbound.channel,
    recipientId: inbound.recipientId,
    mensagem: inbound.mensagem,
    codigo: extraction.codigo,
    externalMessageId: inbound.externalMessageId,
    raw: inbound.raw
  });

  return { kind: "queued", ...created };
}
