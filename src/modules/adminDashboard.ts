import { neon } from "@neondatabase/serverless";
import { config } from "../config.js";
import { extractTicketFinancials, loadCustomerCreditSummaries, type CustomerCreditSummary } from "./credit.js";
import { formatPhoneNumber } from "./customerProfile.js";
import { parseDecimal } from "./money.js";

type RawRow = Record<string, any>;

type AdminGame = {
  date: string;
  sport: string;
  home: string;
  away: string;
  market: string;
  selection: string;
  odd: number | null;
  status: string;
  result: string;
  stakeShare: number;
};

export type AdminBreakdown = {
  label: string;
  count: number;
  amount: number;
  prize: number;
};

export type AdminTicket = {
  id: string;
  externalMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  channel: string;
  customerId: string;
  contact: string;
  registeredPhone: string | null;
  customerName: string;
  username: string | null;
  siteCustomerName: string | null;
  ticketCode: string | null;
  siteTicketCode: string | null;
  status: string;
  siteStatus: string | null;
  confirmed: boolean;
  confirmationCode: string | null;
  amount: number;
  prize: number;
  gameCount: number;
  averageGameAmount: number;
  games: AdminGame[];
  originalMessage: string;
  customerMessage: string | null;
  errorMessage: string | null;
  textSent: boolean;
  imageSent: boolean;
  deliveryError: string | null;
};

export type AdminCustomerSummary = {
  key: string;
  customerName: string;
  customerId: string;
  contact: string;
  registeredPhone: string | null;
  channel: string;
  tickets: number;
  confirmed: number;
  amount: number;
  prize: number;
  games: number;
  averageTicketAmount: number;
  averageGameAmount: number;
  credit: CustomerCreditSummary;
  lastActivity: string;
  lastTicketCode: string | null;
};

export type AdminDashboardData = {
  generatedAt: string;
  version: string;
  filters: {
    q: string;
    status: string;
    channel: string;
    from: string;
    to: string;
    limit: number;
  };
  totals: {
    tickets: number;
    confirmed: number;
    found: number;
    notFound: number;
    errors: number;
    pendingOrOpen: number;
    amount: number;
    prize: number;
    games: number;
    averageTicketAmount: number;
    averageGameAmount: number;
    deliveredText: number;
    deliveredImage: number;
    customers: number;
  };
  statusBreakdown: AdminBreakdown[];
  channelBreakdown: AdminBreakdown[];
  customers: AdminCustomerSummary[];
  tickets: AdminTicket[];
};

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

function numberFrom(value: unknown): number {
  return parseDecimal(value);
}

function nullableString(value: unknown): string | null {
  const text = pickString(value);
  return text || null;
}

function formatResult(item: RawRow): string {
  const directResult = pickString(item.resultado, item.result);

  if (directResult) {
    return directResult;
  }

  const homeScore = item.placar_c;
  const awayScore = item.placar_f;

  if (homeScore !== null && homeScore !== undefined && awayScore !== null && awayScore !== undefined) {
    return `${homeScore} x ${awayScore}`;
  }

  return "";
}

function customerFromRaw(raw: RawRow, siteCustomerName: string | null): { name: string; username: string | null } {
  const message = raw?.message ?? raw?.edited_message ?? raw?.channel_post ?? {};
  const telegramUser = message.from ?? message.chat ?? {};
  const telegramName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim();
  const username = nullableString(telegramUser.username);

  const whatsappName = pickString(
    raw?.pushName,
    raw?.senderName,
    raw?.name,
    raw?.data?.pushName,
    raw?.data?.senderName,
    raw?.data?.name,
    raw?.data?.key?.pushName
  );

  return {
    name: telegramName || whatsappName || siteCustomerName || "Cliente sem nome",
    username
  };
}

function extractGames(payload: RawRow, ticketAmount: number): AdminGame[] {
  const items = Array.isArray(payload?.itens)
    ? payload.itens
    : Array.isArray(payload?.itensBolao)
      ? payload.itensBolao
      : [];
  const stakeShare = items.length > 0 ? ticketAmount / items.length : 0;

  return items.map((item: RawRow) => ({
    date: pickString(item.dt_jogo, item.data, item.date),
    sport: pickString(item.esporte_nome, item.esporte, item.esporte_id),
    home: pickString(item.casa_nome, item.time_casa, item.home, item.casa),
    away: pickString(item.visit_nome, item.time_visitante, item.away, item.visitante),
    market: pickString(item.odd_desc, item.mercado, item.market),
    selection: pickString(item.descricao, item.palpite, item.selection),
    odd: numberFrom(item.taxa || item.odd || item.cotacao) || null,
    status: pickString(item.sit_desc, item.status_desc, item.status),
    result: formatResult(item),
    stakeShare
  }));
}

function normalizeTicket(row: RawRow): AdminTicket {
  const resultPayload = row.result_payload ?? {};
  const ticketPayload = resultPayload.dados_bilhete ?? {};
  const aposta = ticketPayload.aposta ?? {};
  const siteCustomerName = nullableString(aposta.cliente);
  const customer = customerFromRaw(row.raw_payload ?? {}, siteCustomerName);
  const registeredPhone = formatPhoneNumber(nullableString(row.profile_phone_number));
  const financials = extractTicketFinancials(ticketPayload);
  const amount = numberFrom(row.ticket_amount) || financials.amount;
  const prize = numberFrom(row.ticket_prize) || financials.prize;
  const games = extractGames(ticketPayload, amount);

  return {
    id: row.id,
    externalMessageId: nullableString(row.external_message_id),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
    channel: row.channel,
    customerId: `${row.channel}:${row.phone}`,
    contact: row.phone,
    registeredPhone,
    customerName: nullableString(row.profile_display_name) ?? customer.name,
    username: nullableString(row.profile_username) ?? customer.username,
    siteCustomerName,
    ticketCode: nullableString(row.ticket_code),
    siteTicketCode: nullableString(aposta.codigo),
    status: row.status,
    siteStatus: nullableString(aposta.status_desc),
    confirmed: Boolean(row.confirmed),
    confirmationCode: nullableString(row.confirmation_code),
    amount,
    prize,
    gameCount: games.length,
    averageGameAmount: games.length > 0 ? amount / games.length : 0,
    games,
    originalMessage: pickString(row.original_message),
    customerMessage: nullableString(row.customer_message),
    errorMessage: nullableString(row.error_message),
    textSent: Boolean(row.text_sent),
    imageSent: Boolean(row.image_sent),
    deliveryError: nullableString(row.delivery_error)
  };
}

function groupCustomers(tickets: AdminTicket[]): AdminCustomerSummary[] {
  const groups = new Map<string, AdminCustomerSummary>();

  for (const ticket of tickets) {
    const key = `${ticket.channel}:${ticket.contact}`;
    const current = groups.get(key) ?? {
      key,
      customerName: ticket.customerName,
      customerId: key,
      contact: ticket.contact,
      registeredPhone: ticket.registeredPhone,
      channel: ticket.channel,
      tickets: 0,
      confirmed: 0,
      amount: 0,
      prize: 0,
      games: 0,
      averageTicketAmount: 0,
      averageGameAmount: 0,
      credit: {
        limited: false,
        limit: null,
        used: 0,
        payments: 0,
        reserved: 0,
        outstanding: 0,
        available: null
      },
      lastTicketCode: ticket.ticketCode,
      lastActivity: ticket.createdAt
    };

    current.tickets += 1;
    current.confirmed += ticket.confirmed ? 1 : 0;
    current.amount += ticket.amount;
    current.prize += ticket.prize;
    current.games += ticket.gameCount;
    current.averageTicketAmount = current.tickets > 0 ? current.amount / current.tickets : 0;
    current.averageGameAmount = current.games > 0 ? current.amount / current.games : 0;

    if (new Date(ticket.createdAt).getTime() > new Date(current.lastActivity).getTime()) {
      current.lastActivity = ticket.createdAt;
      current.customerName = ticket.customerName;
      current.registeredPhone = ticket.registeredPhone ?? current.registeredPhone;
      current.lastTicketCode = ticket.ticketCode;
    }

    groups.set(key, current);
  }

  return Array.from(groups.values()).sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

function breakdownBy(tickets: AdminTicket[], selector: (ticket: AdminTicket) => string): AdminBreakdown[] {
  const groups = new Map<string, AdminBreakdown>();

  for (const ticket of tickets) {
    const label = selector(ticket) || "Não informado";
    const current = groups.get(label) ?? { label, count: 0, amount: 0, prize: 0 };
    current.count += 1;
    current.amount += ticket.amount;
    current.prize += ticket.prize;
    groups.set(label, current);
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function loadAdminDashboardData(input: {
  q?: string;
  status?: string;
  channel?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<AdminDashboardData> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  const q = input.q?.trim() ?? "";
  const status = input.status?.trim() ?? "";
  const channel = input.channel?.trim() ?? "";
  const from = input.from?.trim() ?? "";
  const to = input.to?.trim() ?? "";
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const filters: string[] = [];
  const params: unknown[] = [];

  filters.push("validation_jobs.ticket_code IS NOT NULL");

  if (status && status !== "todos") {
    params.push(status);
    filters.push(`validation_jobs.status = $${params.length}`);
  }

  if (channel && channel !== "todos") {
    params.push(channel);
    filters.push(`validation_jobs.channel = $${params.length}`);
  }

  if (from) {
    params.push(from);
    filters.push(`validation_jobs.created_at >= $${params.length}::date`);
  }

  if (to) {
    params.push(to);
    filters.push(`validation_jobs.created_at < ($${params.length}::date + interval '1 day')`);
  }

  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const index = params.length;
    filters.push(`(
      lower(coalesce(validation_jobs.phone, '')) like $${index}
      or lower(coalesce(p.phone_number, '')) like $${index}
      or lower(coalesce(p.display_name, '')) like $${index}
      or lower(coalesce(validation_jobs.ticket_code, '')) like $${index}
      or lower(coalesce(validation_jobs.result_payload->'dados_bilhete'->'aposta'->>'cliente', '')) like $${index}
      or lower(coalesce(validation_jobs.result_payload->'dados_bilhete'->'aposta'->>'codigo', '')) like $${index}
      or lower(coalesce(validation_jobs.raw_payload->'message'->'from'->>'first_name', '')) like $${index}
      or lower(coalesce(validation_jobs.raw_payload->'message'->'from'->>'last_name', '')) like $${index}
      or lower(coalesce(validation_jobs.raw_payload->'message'->'from'->>'username', '')) like $${index}
    )`);
  }

  params.push(limit);
  const query = `
    SELECT
      validation_jobs.id,
      validation_jobs.external_message_id,
      validation_jobs.channel,
      validation_jobs.phone,
      validation_jobs.original_message,
      validation_jobs.ticket_code,
      validation_jobs.status,
      validation_jobs.confirmed,
      validation_jobs.confirmation_code,
      validation_jobs.customer_message,
      validation_jobs.error_message,
      validation_jobs.text_sent,
      validation_jobs.image_sent,
      validation_jobs.delivery_error,
      validation_jobs.raw_payload,
      validation_jobs.result_payload,
      validation_jobs.ticket_amount,
      validation_jobs.ticket_prize,
      validation_jobs.ticket_game_count,
      validation_jobs.created_at,
      validation_jobs.updated_at,
      validation_jobs.processed_at,
      p.display_name AS profile_display_name,
      p.username AS profile_username,
      p.phone_number AS profile_phone_number
    FROM validation_jobs
    LEFT JOIN customer_profiles p
      ON p.channel = validation_jobs.channel
     AND p.recipient_id = validation_jobs.phone
    WHERE ${filters.join(" AND ")}
    ORDER BY validation_jobs.created_at DESC
    LIMIT $${params.length}
  `;

  const rows = await neon(config.databaseUrl).query(query, params);
  const tickets = rows.map(normalizeTicket);
  const customers = groupCustomers(tickets);
  const creditSummaries = await loadCustomerCreditSummaries(customers.map((customer) => ({
    channel: customer.channel,
    phone: customer.contact
  })));

  for (const customer of customers) {
    customer.credit = creditSummaries.get(`${customer.channel}:${customer.contact}`) ?? customer.credit;
  }
  const confirmed = tickets.filter((ticket) => ticket.confirmed).length;
  const found = tickets.filter((ticket) => ticket.status === "encontrado").length;
  const notFound = tickets.filter((ticket) => ticket.status === "nao_encontrado" || ticket.status === "codigo_nao_encontrado").length;
  const errors = tickets.filter((ticket) => ticket.status === "erro").length;

  return {
    generatedAt: new Date().toISOString(),
    version: tickets
      .map((ticket) => `${ticket.id}:${ticket.status}:${ticket.confirmed}:${ticket.confirmationCode ?? ""}:${ticket.updatedAt}`)
      .join("|"),
    filters: {
      q,
      status: status || "todos",
      channel: channel || "todos",
      from,
      to,
      limit
    },
    tickets,
    customers,
    statusBreakdown: breakdownBy(tickets, (ticket) => ticket.status),
    channelBreakdown: breakdownBy(tickets, (ticket) => ticket.channel),
    totals: {
      tickets: tickets.length,
      confirmed,
      found,
      notFound,
      errors,
      pendingOrOpen: tickets.filter((ticket) => !ticket.confirmed).length,
      amount: tickets.reduce((total, ticket) => total + ticket.amount, 0),
      prize: tickets.reduce((total, ticket) => total + ticket.prize, 0),
      games: tickets.reduce((total, ticket) => total + ticket.gameCount, 0),
      averageTicketAmount: tickets.length > 0
        ? tickets.reduce((total, ticket) => total + ticket.amount, 0) / tickets.length
        : 0,
      averageGameAmount: tickets.reduce((total, ticket) => total + ticket.gameCount, 0) > 0
        ? tickets.reduce((total, ticket) => total + ticket.amount, 0) / tickets.reduce((total, ticket) => total + ticket.gameCount, 0)
        : 0,
      deliveredText: tickets.filter((ticket) => ticket.textSent).length,
      deliveredImage: tickets.filter((ticket) => ticket.imageSent).length,
      customers: customers.length
    }
  };
}
