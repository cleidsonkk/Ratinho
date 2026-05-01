import type { TicketConfirmationResult, TicketStatus } from "../types.js";
import { formatMoney, type CustomerCreditSummary } from "./credit.js";

type MessageInput = Pick<
  TicketConfirmationResult,
  "confirmado" | "codigo_bilhete" | "codigo_confirmacao" | "mensagem_erro" | "dados_bilhete"
> & {
  status: TicketStatus;
  credit?: TicketConfirmationResult["credit"];
};

function getStatusDescription(result: MessageInput): string | null {
  const ticket = result.dados_bilhete?.aposta;

  if (!ticket || typeof ticket !== "object") {
    return null;
  }

  const statusDescription = (ticket as Record<string, unknown>).status_desc;
  return typeof statusDescription === "string" && statusDescription.trim() ? statusDescription.trim() : null;
}

function getReadableErrorMessage(error: string | null): string | null {
  const raw = error?.trim();

  if (!raw) {
    return null;
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const candidates = jsonMatch ? [jsonMatch[0], raw] : [raw];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const message = parsed.Message ?? parsed.message ?? parsed.error;

      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    } catch {
      // The site sometimes returns plain text instead of JSON.
    }
  }

  const cleaned = raw.replace(/^Erro ao consultar o bilhete:\s*/i, "").trim();

  if (!cleaned || cleaned.length > 240 || cleaned.includes("<html") || cleaned.includes("<!doctype")) {
    return null;
  }

  return cleaned;
}

export function buildCustomerMessage(result: MessageInput): string {
  if (result.status === "limite_excedido") {
    const credit = result.credit;
    const lines = [
      "⚠️ Este bilhete ultrapassa seu limite atual.",
      `Código: ${result.codigo_bilhete}`
    ];

    if (credit?.limit !== undefined) {
      lines.push(`Seu limite: ${formatMoney(credit.limit)}`);
      lines.push(`Em aberto: ${formatMoney(credit.outstanding)} · Bilhete: ${formatMoney(credit.ticketAmount ?? 0)}`);
      lines.push(`Disponível agora: ${formatMoney(credit.available)}`);

      if ((credit.requiredPayment ?? 0) > 0) {
        lines.push(`Para confirmar, faça pagamento mínimo de ${formatMoney(credit.requiredPayment ?? 0)}.`);
      }
    }

    lines.push("Ou aguarde o administrador liberar mais limite.");
    return lines.join("\n");
  }

  if (result.confirmado) {
    const lines = [
      "✅ Bilhete confirmado com sucesso!",
      `Código: ${result.codigo_bilhete}`
    ];

    if (result.codigo_confirmacao) {
      lines.push(`Confirmação: ${result.codigo_confirmacao}`);
    }

    if (result.credit?.available !== undefined) {
      lines.push(`Limite disponível: ${formatMoney(result.credit.available)}`);
    }

    lines.push("Guarde este comprovante. Boa sorte! 🍀");
    return lines.join("\n");
  }

  if (result.status === "encontrado" && result.mensagem_erro?.includes("pendente de confirmacao")) {
    const statusDescription = getStatusDescription(result);

    return [
      "✅ Bilhete localizado.",
      `Código: ${result.codigo_bilhete}`,
      statusDescription ? `Status: ${statusDescription}` : "Status: já confirmado",
      "Este bilhete não está pendente de confirmação."
    ].join("\n");
  }

  if (result.status === "nao_encontrado") {
    return [
      "⚠️ Não conseguimos localizar o código informado.",
      "Verifique se digitou corretamente e envie novamente."
    ].join("\n");
  }

  if (result.status === "erro") {
    const readableError = getReadableErrorMessage(result.mensagem_erro);

    if (readableError) {
      return [
        "Nao foi possivel confirmar este bilhete.",
        `Codigo: ${result.codigo_bilhete}`,
        `Motivo: ${readableError}`
      ].join("\n");
    }
  }

  return [
    "🔄 Tivemos uma instabilidade ao consultar seu bilhete.",
    "Tente novamente em alguns minutos."
  ].join("\n");
}

export function buildExtractionFailureMessage(): string {
  return [
    "⚠️ Não consegui identificar o código do bilhete.",
    "Envie o código com 12 caracteres, com ou sem espaços.",
    "Exemplo: ABCD 1234 WXYZ"
  ].join("\n");
}

export function buildMultipleCodesMessage(summary: CustomerCreditSummary | null): string {
  const lines = [
    "⚠️ Envie apenas 1 código de bilhete por vez.",
    "Assim consigo validar o limite e confirmar com segurança."
  ];

  if (summary) {
    lines.push(`Seu limite: ${formatMoney(summary.limit)}`);
    lines.push(`Disponível agora: ${formatMoney(summary.available)}`);
  }

  return lines.join("\n");
}

export function buildTelegramWelcomeMessage(): string {
  return [
    "Olá! Envie o código do bilhete para validação.",
    "Pode mandar com espaços ou tudo junto.",
    "Para aparecer com celular no painel, toque em Compartilhar meu telefone.",
    "Exemplo: ABCD 1234 WXYZ"
  ].join("\n");
}

export function buildTelegramContactRegisteredMessage(phoneNumber: string): string {
  return [
    "✅ Telefone cadastrado com sucesso.",
    `Celular: ${phoneNumber}`,
    "Agora envie 1 código de bilhete por vez."
  ].join("\n");
}

export function buildTelegramContactRejectedMessage(): string {
  return [
    "⚠️ Para sua segurança, envie o seu próprio contato pelo botão Compartilhar meu telefone.",
    "Depois envie 1 código de bilhete por vez."
  ].join("\n");
}
export function buildUnauthorizedPhoneMessage(): string {
  return [
    "Seu numero ainda nao esta cadastrado para confirmar bilhetes neste atendimento.",
    "Solicite ao administrador a liberacao do seu celular antes de enviar novos codigos."
  ].join("\n");
}

export function buildBlockedPhoneMessage(): string {
  return [
    "Seu cadastro esta bloqueado no momento para confirmacao de bilhetes.",
    "Entre em contato com o administrador para solicitar a liberacao do seu acesso."
  ].join("\n");
}
