import { log } from "../logger.js";
import type { ValidationJob } from "../types.js";
import { notifyAdminSafely, notifyAdminValidationResult } from "./adminNotifier.js";
import { appendAuditLog } from "./auditLog.js";
import {
  applyConfirmedTicketToCredit,
  commitCustomerCreditReservation,
  type CustomerCreditSummary,
  extractTicketFinancials,
  releaseCustomerCreditReservation,
  reserveCustomerCredit
} from "./credit.js";
import { buildCustomerMessage } from "./messageBuilder.js";
import { sendImage, sendText } from "./notifier.js";
import { markDeliveryStatus, markJobFinished, markJobProcessing } from "./persistence.js";
import { TicketAutomation } from "./ticketAutomation.js";

const automation = new TicketAutomation();

export async function processValidationJob(job: ValidationJob): Promise<void> {
  log("info", "Iniciando validação de bilhete", {
    jobId: job.id,
    channel: job.channel,
    recipientId: job.recipientId,
    codigo: job.codigo
  });

  await markJobProcessing(job.id);

  let creditReserved = false;
  let creditSnapshot: CustomerCreditSummary | undefined;
  const result = await automation.validateAndConfirm(job.codigo, {
    beforeConfirm: async ({ dados_bilhete }) => {
      const financials = extractTicketFinancials(dados_bilhete);
      const decision = await reserveCustomerCredit({
        jobId: job.id,
        channel: job.channel,
        phone: job.recipientId,
        ticketCode: job.codigo,
        ticketAmount: financials.amount
      });

      creditReserved = decision.allowed && Boolean(decision.credit?.limited);
      creditSnapshot = decision.credit;
      return decision;
    }
  });

  if (result.confirmado && creditSnapshot) {
    result.credit = applyConfirmedTicketToCredit(creditSnapshot);
  }

  const message = buildCustomerMessage(result);

  await markJobFinished(job.id, result, message);

  if (creditReserved) {
    if (result.confirmado) {
      await commitCustomerCreditReservation(job.id);
    } else {
      await releaseCustomerCreditReservation(job.id);
    }
  }

  let textSent = false;
  let imageSent = false;

  try {
    await sendText(job.channel, job.recipientId, message);
    textSent = true;

    if (result.screenshot_base64) {
      await sendImage(job.channel, job.recipientId, result.screenshot_base64, `Comprovante do bilhete ${job.codigo}`);
      imageSent = true;
    }

    await markDeliveryStatus({
      jobId: job.id,
      textSent,
      imageSent,
      deliveryError: null
    });
  } catch (error) {
    const deliveryError = error instanceof Error ? error.message : String(error);

    await markDeliveryStatus({
      jobId: job.id,
      textSent,
      imageSent,
      deliveryError
    });

    await notifyAdminSafely(notifyAdminValidationResult(job, {
      ...result,
      mensagem_erro: result.mensagem_erro
        ? `${result.mensagem_erro} | Falha ao enviar resposta ao cliente: ${deliveryError}`
        : `Falha ao enviar resposta ao cliente: ${deliveryError}`
    }), {
      jobId: job.id,
      channel: job.channel,
      recipientId: job.recipientId,
      codigo: job.codigo,
      deliveryError
    });

    throw error;
  }

  await appendAuditLog({
    timestamp: new Date().toISOString(),
    jobId: job.id,
    channel: job.channel,
    recipientId: job.recipientId,
    codigo: job.codigo,
    status: result.status,
    confirmado: result.confirmado,
    codigo_confirmacao: result.codigo_confirmacao,
    screenshot_path: result.screenshot_path,
    mensagem_erro: result.mensagem_erro
  }).catch((error) => {
    log("warn", "Falha ao gravar audit log local", {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  await notifyAdminSafely(notifyAdminValidationResult(job, result), {
    jobId: job.id,
    channel: job.channel,
    recipientId: job.recipientId,
    codigo: job.codigo
  });

  log("info", "Validação finalizada", {
    jobId: job.id,
    channel: job.channel,
    recipientId: job.recipientId,
    codigo: job.codigo,
    status: result.status,
    confirmado: result.confirmado
  });
}
