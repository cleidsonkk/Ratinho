import { config } from "../config.js";
import { log } from "../logger.js";
import type { InboundMessage, TicketConfirmationResult, ValidationJob } from "../types.js";
import { loadAdminTelegramTargets, markAdminNotificationTargetNotified, syncConfiguredAdminTelegramTargets } from "./adminNotificationTargets.js";
import { extractTicketFinancials, formatMoney, getCustomerCreditSummary, type CustomerCreditSummary } from "./credit.js";
import { customerIdentityFromInbound, formatPhoneNumber, getCustomerProfile } from "./customerProfile.js";
import { sendText } from "./notifier.js";

const TELEGRAM_MESSAGE_LIMIT = 3900;
const WHATSAPP_MESSAGE_LIMIT = 1000;

type SendAdminMessageResult = {
  targets: number;
  messages: number;
};

type RawRow = Record<string, any>;

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function ticketPayload(data: Record<string, unknown> | null): RawRow {
  if (!data || typeof data !== "object") {
    return {};
  }

  const payload = data as RawRow;
  return payload.dados_bilhete && typeof payload.dados_bilhete === "object"
    ? payload.dados_bilhete as RawRow
    : payload;
}

function ticketItems(data: Record<string, unknown> | null): RawRow[] {
  const payload = ticketPayload(data);

  if (Array.isArray(payload.itens)) {
    return payload.itens;
  }

  if (Array.isArray(payload.itensBolao)) {
    return payload.itensBolao;
  }

  return [];
}

function formatDateTime(value: unknown): string {
  const text = pickString(value);

  if (!text) {
    return "-";
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    return text;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(date);
}

function statusHeading(result: TicketConfirmationResult): string {
  if (result.confirmado) {
    return "[CONFIRMADO] Bilhete confirmado";
  }

  if (result.status === "limite_excedido") {
    return "[LIMITE] Cliente sem limite para confirmar";
  }

  if (result.status === "encontrado") {
    return "[ATENCAO] Bilhete localizado sem confirmacao";
  }

  if (result.status === "nao_encontrado") {
    return "[NAO LOCALIZADO] Codigo nao encontrado";
  }

  return "[ERRO] Falha na validacao";
}

function creditLines(credit: CustomerCreditSummary | null): string[] {
  if (!credit) {
    return ["Financeiro: nao foi possivel carregar o limite do cliente."];
  }

  const lines = [
    "Financeiro do cliente:",
    `- Limite: ${formatMoney(credit.limit)}`,
    `- Em aberto: ${formatMoney(credit.outstanding)}`,
    `- Disponivel: ${formatMoney(credit.available)}`,
    `- Pago: ${formatMoney(credit.payments)}`,
    `- Reservado: ${formatMoney(credit.reserved)}`
  ];

  if ((credit.ticketAmount ?? 0) > 0) {
    lines.push(`- Valor deste bilhete: ${formatMoney(credit.ticketAmount ?? 0)}`);
  }

  if ((credit.requiredPayment ?? 0) > 0) {
    lines.push(`- Pagamento minimo para liberar: ${formatMoney(credit.requiredPayment ?? 0)}`);
  }

  if (credit.limit && credit.available !== null) {
    const availablePercent = credit.limit > 0 ? (credit.available / credit.limit) * 100 : 0;
    lines.push(`- Uso do limite: ${(100 - availablePercent).toFixed(0)}%`);

    if (availablePercent <= config.adminNotifications.lowCreditPercent) {
      lines.push(`- Alerta: limite quase atingido (${availablePercent.toFixed(0)}% disponivel).`);
    }

    if (credit.outstanding >= credit.limit) {
      lines.push("- Alerta: cliente atingiu ou estourou o limite.");
    }
  }

  return lines;
}

function gameLines(data: Record<string, unknown> | null): string[] {
  const items = ticketItems(data);

  if (items.length === 0) {
    return ["Jogos: nenhum jogo detalhado retornado pelo site."];
  }

  const lines = [`Jogos do bilhete (${items.length}):`];

  items.slice(0, 20).forEach((item, index) => {
    const home = pickString(item.casa_nome, item.time_casa, item.home, item.casa) || "Casa";
    const away = pickString(item.visit_nome, item.time_visitante, item.away, item.visitante) || "Visitante";
    const market = pickString(item.odd_desc, item.mercado, item.market) || "-";
    const selection = pickString(item.descricao, item.palpite, item.selection) || "-";
    const odd = pickString(item.taxa, item.odd, item.cotacao) || "-";
    const date = formatDateTime(pickString(item.dt_jogo, item.data, item.date));
    const status = pickString(item.sit_desc, item.status_desc, item.status) || "-";

    lines.push(`${index + 1}. ${home} x ${away}`);
    lines.push(`   Data: ${date}`);
    lines.push(`   Mercado: ${market}`);
    lines.push(`   Palpite: ${selection} | Odd: ${odd} | Status: ${status}`);
  });

  if (items.length > 20) {
    lines.push(`Mais ${items.length - 20} jogo(s) no painel administrativo.`);
  }

  return lines;
}

function messageLimit(channel: "telegram" | "whatsapp"): number {
  return channel === "telegram" ? TELEGRAM_MESSAGE_LIMIT : WHATSAPP_MESSAGE_LIMIT;
}

function splitMessage(text: string, channel: "telegram" | "whatsapp"): string[] {
  const limit = messageLimit(channel);

  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > limit) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

async function sendAdminMessage(text: string): Promise<SendAdminMessageResult> {
  await syncConfiguredAdminTelegramTargets();

  const targets = await loadAdminTelegramTargets();

  if (targets.length === 0) {
    log("warn", "Nenhum destino do administrador configurado", {
      channel: config.adminNotifications.channel,
      hint: config.adminNotifications.channel === "whatsapp"
        ? "Defina ADMIN_WHATSAPP_NUMBERS no ambiente para ativar as notificacoes."
        : "Envie /admin <senha-do-painel> no bot para ativar as notificacoes."
    });
    return { targets: 0, messages: 0 };
  }

  await Promise.all(targets.map(async (target) => {
    const chunks = splitMessage(text, target.channel);

    for (const chunk of chunks) {
      await sendText(target.channel, target.targetId, chunk);
    }

    await markAdminNotificationTargetNotified(target.channel, target.targetId);
  }));

  return {
    targets: targets.length,
    messages: targets.reduce((sum, target) => sum + splitMessage(text, target.channel).length, 0)
  };
}

function panelUrl(): string | null {
  const base = config.publicBaseUrl.trim();
  return base ? `${base.replace(/\/$/, "")}/api/admin` : null;
}

export async function sendAdminTestNotification(): Promise<SendAdminMessageResult> {
  const lines = [
    "[TESTE] Notificacao administrativa ativa",
    `Horario: ${formatDateTime(new Date().toISOString())}`,
    "Evento: teste manual pelo painel admin",
    config.adminNotifications.channel === "whatsapp"
      ? "Se esta mensagem chegou, o WhatsApp do administrador esta configurado corretamente."
      : "Se esta mensagem chegou, o Telegram do administrador esta cadastrado corretamente."
  ];
  const url = panelUrl();

  if (url) {
    lines.push(`Painel: ${url}`);
  }

  return await sendAdminMessage(lines.join("\n"));
}

export async function notifyAdminValidationResult(job: ValidationJob, result: TicketConfirmationResult): Promise<void> {
  const profile = await getCustomerProfile(job.channel, job.recipientId).catch(() => null);
  const financials = extractTicketFinancials(result.dados_bilhete);
  const credit = result.credit ?? await getCustomerCreditSummary(job.channel, job.recipientId).catch(() => null);
  const phoneNumber = formatPhoneNumber(profile?.phoneNumber ?? null);
  const customerName = profile?.displayName ?? "Cliente sem nome";
  const username = profile?.username ? `@${profile.username}` : null;
  const payload = ticketPayload(result.dados_bilhete);
  const aposta = payload.aposta && typeof payload.aposta === "object" ? payload.aposta as RawRow : {};
  const url = panelUrl();

  const lines = [
    statusHeading(result),
    `Horario: ${formatDateTime(new Date().toISOString())}`,
    "",
    "Cliente:",
    `- Nome: ${customerName}`,
    `- Canal: ${job.channel}`,
    `- ID Telegram/contato: ${job.recipientId}`
  ];

  if (phoneNumber) {
    lines.push(`- Celular: ${phoneNumber}`);
  }

  if (username) {
    lines.push(`- Usuario: ${username}`);
  }

  lines.push(
    "",
    "Bilhete:",
    `- Codigo recebido: ${job.codigo}`,
    `- Codigo no site: ${pickString(aposta.codigo) || result.codigo_bilhete || "-"}`,
    `- Cliente no site: ${pickString(aposta.cliente) || "-"}`,
    `- Status no site: ${pickString(aposta.status_desc) || result.status}`,
    `- Valor: ${formatMoney(financials.amount)}`,
    `- Jogos: ${financials.gameCount}`,
    `- Premio possivel: ${formatMoney(financials.prize)}`
  );

  if (result.codigo_confirmacao) {
    lines.push(`- Confirmacao: ${result.codigo_confirmacao}`);
  }

  if (result.mensagem_erro) {
    lines.push(`- Ocorrencia: ${result.mensagem_erro}`);
  }

  lines.push("", ...creditLines(credit), "", ...gameLines(result.dados_bilhete));

  if (url) {
    lines.push("", `Painel: ${url}`);
  }

  await sendAdminMessage(lines.join("\n"));
}

export async function notifyAdminExtractionFailure(inbound: InboundMessage, reason: "codigo_invalido" | "multiplos_codigos"): Promise<void> {
  const identity = customerIdentityFromInbound(inbound);
  const profile = await getCustomerProfile(inbound.channel, inbound.recipientId).catch(() => null);
  const phoneNumber = formatPhoneNumber(profile?.phoneNumber ?? inbound.contactPhone ?? null);
  const title = reason === "multiplos_codigos"
    ? "[ATENCAO] Cliente enviou mais de um codigo"
    : "[ATENCAO] Codigo nao identificado";
  const lines = [
    title,
    `Horario: ${formatDateTime(new Date().toISOString())}`,
    `Cliente: ${profile?.displayName ?? identity.displayName ?? "Cliente sem nome"}`,
    `Canal: ${inbound.channel}`,
    `ID Telegram/contato: ${inbound.recipientId}`
  ];

  if (phoneNumber) {
    lines.push(`Celular: ${phoneNumber}`);
  }

  if (identity.username) {
    lines.push(`Usuario: @${identity.username}`);
  }

  lines.push(
    `Motivo: ${reason === "multiplos_codigos" ? "mais de um codigo na mesma mensagem" : "codigo fora do padrao"}`,
    `Mensagem recebida: ${inbound.mensagem.slice(0, 500)}`
  );

  await sendAdminMessage(lines.join("\n"));
}

export async function notifyAdminContactUpdate(inbound: InboundMessage, stored: boolean, phoneNumber: string | null): Promise<void> {
  const identity = customerIdentityFromInbound(inbound);
  const formattedPhone = formatPhoneNumber(phoneNumber);
  const lines = [
    stored ? "[CLIENTE] Celular cadastrado" : "[ATENCAO] Contato recusado",
    `Horario: ${formatDateTime(new Date().toISOString())}`,
    `Cliente: ${identity.displayName ?? "Cliente sem nome"}`,
    `Canal: ${inbound.channel}`,
    `ID Telegram/contato: ${inbound.recipientId}`
  ];

  if (identity.username) {
    lines.push(`Usuario: @${identity.username}`);
  }

  if (formattedPhone) {
    lines.push(`Celular: ${formattedPhone}`);
  }

  if (!stored) {
    lines.push("Motivo: cliente tentou enviar contato que nao pertence ao proprio usuario do Telegram.");
  }

  await sendAdminMessage(lines.join("\n"));
}

export async function notifyAdminSafely(promise: Promise<void>, context: Record<string, unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    log("warn", "Falha ao notificar administrador", {
      ...context,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
