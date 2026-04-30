import type { CreditSnapshot } from "../src/types.js";
import { applyConfirmedTicketToCredit, applyPaymentToCredit, requiredPaymentForTicket } from "../src/modules/credit.js";
import { buildCustomerMessage } from "../src/modules/messageBuilder.js";

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(actual: string, expected: string, message: string): void {
  const normalizedActual = actual.replace(/\u00a0/g, " ");

  if (!normalizedActual.includes(expected)) {
    throw new Error(`${message}: expected text to include "${expected}", got "${actual}"`);
  }
}

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

const afterConfirmation = applyConfirmedTicketToCredit(initialCredit);
assertEqual(afterConfirmation.outstanding, 10, "confirmed ticket should increase outstanding");
assertEqual(afterConfirmation.available, 140, "confirmed ticket should reduce available limit");

const blockedCredit: CreditSnapshot = {
  limited: true,
  limit: 150,
  used: 150,
  payments: 0,
  reserved: 0,
  outstanding: 150,
  available: 0,
  ticketAmount: 10
};

const requiredPayment = requiredPaymentForTicket(blockedCredit);
assertEqual(requiredPayment, 10, "required payment should be ticket amount when limit is exhausted");

const blockedMessage = buildCustomerMessage({
  confirmado: false,
  codigo_bilhete: "ABCD 1234 WXYZ",
  codigo_confirmacao: null,
  mensagem_erro: "Limite do cliente excedido.",
  dados_bilhete: null,
  status: "limite_excedido",
  credit: { ...blockedCredit, requiredPayment }
});

assertIncludes(blockedMessage, "Seu limite: R$ 150,00", "blocked message should show limit");
assertIncludes(blockedMessage, "Para confirmar, faça pagamento mínimo de R$ 10,00.", "blocked message should show minimum payment");

const overLimitCredit: CreditSnapshot = {
  ...blockedCredit,
  used: 170,
  outstanding: 170,
  ticketAmount: 10
};

assertEqual(requiredPaymentForTicket(overLimitCredit), 30, "required payment should cover overdue amount plus new ticket");

const exhaustedCredit: CreditSnapshot = {
  limited: true,
  limit: 100,
  used: 100,
  payments: 0,
  reserved: 0,
  outstanding: 100,
  available: 0
};

const partialPayment = applyPaymentToCredit(exhaustedCredit, 50);
assertEqual(partialPayment.outstanding, 50, "partial payment should reduce outstanding");
assertEqual(partialPayment.payments, 50, "partial payment should be recorded in total paid");
assertEqual(partialPayment.available, 50, "partial payment should release only the amount paid");

const exactLimitCredit: CreditSnapshot = {
  limited: true,
  limit: 150,
  used: 140,
  payments: 0,
  reserved: 0,
  outstanding: 140,
  available: 10,
  ticketAmount: 10
};

const afterExactLimit = applyConfirmedTicketToCredit(exactLimitCredit);
assertEqual(afterExactLimit.outstanding, 150, "ticket that reaches the limit should be counted");
assertEqual(afterExactLimit.available, 0, "ticket that reaches the limit should leave zero available");
assertEqual(requiredPaymentForTicket({ ...afterExactLimit, ticketAmount: 1 }), 1, "next ticket after limit is exhausted should require payment");

console.log("Credit limit checks passed.");
