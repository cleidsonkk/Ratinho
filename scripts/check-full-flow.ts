import type { CreditSnapshot, TicketConfirmationResult } from "../src/types.js";
import {
  applyConfirmedTicketToCredit,
  applyPaymentToCredit,
  requiredPaymentForTicket
} from "../src/modules/credit.js";
import { formatPhoneNumber, isTelegramContactMessage } from "../src/modules/customerProfile.js";
import {
  buildBlockedPhoneMessage,
  buildCustomerMessage,
  buildExtractionFailureMessage,
  buildMultipleCodesMessage,
  buildTelegramContactRegisteredMessage,
  buildTelegramWelcomeMessage,
  buildUnauthorizedPhoneMessage
} from "../src/modules/messageBuilder.js";
import { buildAuthorizedPhoneVariants, canonicalizeAuthorizedPhone } from "../src/modules/authorizedPhones.js";
import { parseAdminNotificationCommand } from "../src/modules/adminNotificationCommand.js";
import { parseInboundTelegramMessage } from "../src/modules/telegramWebhookParser.js";
import { extractTicketCode, extractTicketCodes } from "../src/modules/ticketExtractor.js";
import { parseInboundWhatsAppMessage } from "../src/modules/webhookParser.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ");
}

function assertIncludes(actual: string, expected: string, message: string): void {
  const normalizedActual = normalizeText(actual);

  if (!normalizedActual.includes(expected)) {
    throw new Error(`${message}: expected "${expected}" in "${actual}"`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const startUpdate = {
  update_id: 1001,
  message: {
    message_id: 1,
    from: {
      id: 7001,
      is_bot: false,
      first_name: "Cliente",
      last_name: "Teste",
      username: "cliente_teste"
    },
    chat: {
      id: 7001,
      type: "private",
      first_name: "Cliente",
      last_name: "Teste"
    },
    text: "/start"
  }
};

const startInbound = parseInboundTelegramMessage(startUpdate);
assert(startInbound, "telegram /start must be parsed");
assertEqual(startInbound?.recipientId, "7001", "telegram chat id must be used for replies");
assertIncludes(buildTelegramWelcomeMessage(), "Compartilhar meu telefone", "welcome message must ask for phone sharing");
assertEqual(parseAdminNotificationCommand("/admin senha-teste"), "senha-teste", "admin notification command must extract password");
assertEqual(parseAdminNotificationCommand("/notificacoes senha forte"), "senha forte", "admin notification command must accept alias");
assertEqual(parseAdminNotificationCommand("/start"), null, "normal Telegram command must not be treated as admin registration");

const contactUpdate = {
  update_id: 1002,
  message: {
    message_id: 2,
    from: {
      id: 7001,
      is_bot: false,
      first_name: "Cliente",
      last_name: "Teste"
    },
    chat: {
      id: 7001,
      type: "private",
      first_name: "Cliente",
      last_name: "Teste"
    },
    contact: {
      phone_number: "5579999105302",
      first_name: "Cliente",
      last_name: "Teste",
      user_id: 7001
    }
  }
};

const contactInbound = parseInboundTelegramMessage(contactUpdate);
assert(contactInbound, "telegram contact must be parsed");
assert(isTelegramContactMessage(contactInbound!), "telegram contact must be detected");
assertEqual(contactInbound?.contactPhone, "5579999105302", "contact phone must be extracted");
assertEqual(formatPhoneNumber(contactInbound?.contactPhone ?? null), "+55 79 9 9910-5302", "phone must be formatted for admin");
assertIncludes(buildTelegramContactRegisteredMessage(formatPhoneNumber(contactInbound?.contactPhone ?? null) ?? ""), "+55 79 9 9910-5302", "contact confirmation must show phone");

const ticketMessage = "confirma pra mim V072ZHQWNZV9";
const extraction = extractTicketCode(ticketMessage);
assert(extraction.codigo_encontrado, "single compact ticket code must be found");
assertEqual(extraction.codigo, "V072 ZHQW NZV9", "single ticket code must be normalized");

const spacedExtraction = extractTicketCode("V072 ZHQW NZV9");
assert(spacedExtraction.codigo_encontrado, "spaced ticket code must be found");
assertEqual(spacedExtraction.codigo, "V072 ZHQW NZV9", "spaced ticket code must stay normalized");

const metaInbound = parseInboundWhatsAppMessage({
  object: "whatsapp_business_account",
  entry: [{
    changes: [{
      value: {
        messages: [{
          from: "5579999105302",
          id: "wamid.test",
          type: "text",
          text: { body: "confirma pra mim V072ZHQWNZV9" }
        }]
      }
    }]
  }]
});
assert(metaInbound, "Meta WhatsApp payload must be parsed");
assertEqual(metaInbound?.recipientId, "5579999105302", "Meta WhatsApp sender must be used as recipient");
assertEqual(metaInbound?.mensagem, "confirma pra mim V072ZHQWNZV9", "Meta WhatsApp text body must be parsed");
assertEqual(metaInbound?.externalMessageId, "wamid.test", "Meta WhatsApp message id must be parsed");
assertEqual(canonicalizeAuthorizedPhone("557999105302"), "5579999105302", "whatsapp phone without ninth digit must canonicalize to stored brazilian mobile");
assertEqual(canonicalizeAuthorizedPhone("79999105302"), "5579999105302", "local brazilian mobile must canonicalize with country code");
assertEqual(buildAuthorizedPhoneVariants("5579999105302").includes("557999105302"), true, "authorized phone variants must include whatsapp payload without ninth digit");
assertIncludes(buildUnauthorizedPhoneMessage(), "nao esta cadastrado", "unauthorized response must explain missing registration");
assertIncludes(buildBlockedPhoneMessage(), "bloqueado", "blocked response must explain access block");

const multiCodes = extractTicketCodes("V072ZHQWNZV9 e G3J4IZPP4J80");
assertEqual(multiCodes.length, 2, "multiple codes must be detected");
assertIncludes(buildMultipleCodesMessage({
  limited: true,
  limit: 150,
  used: 0,
  payments: 0,
  reserved: 0,
  outstanding: 0,
  available: 150
}), "Envie apenas 1 código", "multiple-code response must block batch confirmation");

assertIncludes(buildExtractionFailureMessage(), "12 caracteres", "invalid-code response must explain the expected code size");

const initialCredit: CreditSnapshot = {
  limited: true,
  limit: 150,
  used: 0,
  payments: 0,
  reserved: 0,
  outstanding: 0,
  available: 150,
  ticketAmount: 10
};

const afterFirstTicket = applyConfirmedTicketToCredit(initialCredit);
assertEqual(afterFirstTicket.available, 140, "confirmed R$ 10 ticket must reduce available R$ 150 to R$ 140");
assertEqual(afterFirstTicket.outstanding, 10, "confirmed R$ 10 ticket must create R$ 10 outstanding");

const confirmedResult: TicketConfirmationResult = {
  confirmado: true,
  codigo_confirmacao: "V072ZHQWNZV9",
  screenshot_base64: null,
  screenshot_path: null,
  mensagem_erro: null,
  status: "encontrado",
  codigo_bilhete: "V072 ZHQW NZV9",
  dados_bilhete: null,
  credit: afterFirstTicket
};

assertIncludes(buildCustomerMessage(confirmedResult), "Limite disponível: R$ 140,00", "confirmation response must show remaining limit");

const exhaustedCredit: CreditSnapshot = {
  limited: true,
  limit: 100,
  used: 100,
  payments: 0,
  reserved: 0,
  outstanding: 100,
  available: 0,
  ticketAmount: 10
};

const requiredPayment = requiredPaymentForTicket(exhaustedCredit);
assertEqual(requiredPayment, 10, "exhausted customer must pay at least the next ticket amount");

const blockedResult: TicketConfirmationResult = {
  confirmado: false,
  codigo_confirmacao: null,
  screenshot_base64: null,
  screenshot_path: null,
  mensagem_erro: "Limite do cliente excedido.",
  status: "limite_excedido",
  codigo_bilhete: "ABCD 1234 WXYZ",
  dados_bilhete: null,
  credit: {
    ...exhaustedCredit,
    requiredPayment
  }
};

const blockedMessage = buildCustomerMessage(blockedResult);
assertIncludes(blockedMessage, "Para confirmar, faça pagamento mínimo de R$ 10,00.", "blocked response must show minimum payment");
assert(!blockedMessage.includes("Bilhete confirmado"), "blocked response must not look like a confirmation");

const siteErrorResult: TicketConfirmationResult = {
  confirmado: false,
  codigo_confirmacao: null,
  screenshot_base64: null,
  screenshot_path: null,
  mensagem_erro: "{\"Message\":\"Servidor: Time A x Time B - Horario limite para o jogo encerrado.\"}",
  status: "erro",
  codigo_bilhete: "W9T6 AGA8 3PR8",
  dados_bilhete: null
};

const siteErrorMessage = buildCustomerMessage(siteErrorResult);
assertIncludes(siteErrorMessage, "Nao foi possivel confirmar este bilhete.", "site error response must avoid generic instability text");
assertIncludes(siteErrorMessage, "jogo encerrado", "site error response must explain the real site reason");

const partialPayment = applyPaymentToCredit(exhaustedCredit, 50);
assertEqual(partialPayment.outstanding, 50, "partial payment must reduce outstanding only by paid amount");
assertEqual(partialPayment.available, 50, "partial payment must release only paid amount");

const canConfirmAfterPartialPayment = {
  ...partialPayment,
  ticketAmount: 50
};
assertEqual(requiredPaymentForTicket(canConfirmAfterPartialPayment), 0, "ticket up to available partial payment must be allowed");

const stillBlockedAfterPartialPayment = {
  ...partialPayment,
  ticketAmount: 60
};
assertEqual(requiredPaymentForTicket(stillBlockedAfterPartialPayment), 10, "ticket above partial payment must request missing amount");

console.log("Full flow checks passed.");
