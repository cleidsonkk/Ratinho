import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { isAdminRequestAuthorized, verifyAdminCredentials } from "../src/modules/adminAuth.js";
import { clearOperationalData, deleteValidationJobById } from "../src/modules/adminCleanup.js";
import { countAdminNotificationTargets } from "../src/modules/adminNotificationTargets.js";
import { sendAdminTestNotification } from "../src/modules/adminNotifier.js";
import {
  type AdminBreakdown,
  type AdminCustomerSummary,
  type AdminDashboardData,
  type AdminTicket,
  loadAdminDashboardData
} from "../src/modules/adminDashboard.js";
import { formatMoney as formatCreditMoney, parseMoneyInput, recordCustomerCreditPayment, setCustomerCreditLimit } from "../src/modules/credit.js";
import { recordSecurityEvent } from "../src/modules/persistence.js";

const STATUSES = [
  "todos",
  "confirmado",
  "encontrado",
  "nao_encontrado",
  "codigo_nao_encontrado",
  "erro",
  "limite_excedido",
  "queued",
  "processing"
] as const;

const CHANNELS = ["todos", "telegram", "whatsapp"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestSearchParams(req: any): URLSearchParams {
  const host = String(req.headers?.host ?? "localhost");
  const protocol = String(req.headers?.["x-forwarded-proto"] ?? "https").split(",")[0].trim() || "https";
  const url = new URL(String(req.url ?? "/api/admin"), `${protocol}://${host}`);
  return url.searchParams;
}

function searchParamValue(params: URLSearchParams, name: string): string {
  return params.get(name) ?? "";
}

async function readForm(req: any): Promise<URLSearchParams> {
  if (typeof req.body === "string") {
    return new URLSearchParams(req.body);
  }

  if (req.body && typeof req.body === "object") {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(req.body)) {
      if (typeof value === "string") {
        params.set(key, value);
      } else if (typeof value === "number") {
        params.set(key, String(value));
      }
    }

    return params;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function redirectToAdmin(res: any, notice: string | null = null): void {
  res.statusCode = 303;
  res.setHeader("Location", notice ? `/api/admin?notice=${encodeURIComponent(notice)}` : "/api/admin");
  res.end();
}

function requireAdminPassword(form: URLSearchParams, res: any): boolean {
  const password = form.get("adminPassword") ?? "";

  if (!verifyAdminCredentials(config.admin.username, password)) {
    res.status(403).send("Senha do administrador invalida.");
    return false;
  }

  return true;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function requestIp(req: any): string {
  return firstHeader(req.headers?.["x-forwarded-for"]).split(",")[0].trim()
    || firstHeader(req.headers?.["x-real-ip"])
    || req.socket?.remoteAddress
    || "";
}

async function recordAdminCleanupEvent(req: any, eventType: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await recordSecurityEvent({
      id: randomUUID(),
      eventType,
      ip: requestIp(req),
      userAgent: firstHeader(req.headers?.["user-agent"]),
      metadata
    });
  } catch (error) {
    console.error("Falha ao registrar auditoria administrativa", error);
  }
}

async function handleAdminAction(req: any, res: any): Promise<void> {
  const form = await readForm(req);
  const action = form.get("action") ?? "";

  if (action === "delete_job") {
    if (!requireAdminPassword(form, res)) {
      return;
    }

    const jobId = form.get("jobId") ?? "";

    if (!UUID_PATTERN.test(jobId)) {
      res.status(400).send("Registro invalido.");
      return;
    }

    const deleted = await deleteValidationJobById(jobId);
    await recordAdminCleanupEvent(req, "admin_delete_validation_job", { jobId, deleted });
    redirectToAdmin(res);
    return;
  }

  if (action === "clear_operational_data") {
    if (!requireAdminPassword(form, res)) {
      return;
    }

    const deleted = await clearOperationalData();
    await recordAdminCleanupEvent(req, "admin_clear_operational_data", deleted);
    redirectToAdmin(res);
    return;
  }

  if (action === "send_admin_notification_test") {
    if (!requireAdminPassword(form, res)) {
      return;
    }

    const result = await sendAdminTestNotification();
    const channel = adminNotificationChannelLabel();
    redirectToAdmin(
      res,
      result.targets > 0
        ? `Teste enviado para ${result.targets} destino(s) administrativo(s) via ${channel}.`
        : config.adminNotifications.channel === "whatsapp"
          ? "Nenhum WhatsApp administrativo configurado. Defina ADMIN_WHATSAPP_NUMBERS no ambiente."
          : "Nenhum Telegram administrativo cadastrado. Envie /admin sua-senha no bot."
    );
    return;
  }

  const channel = form.get("channel") ?? "";
  const phone = form.get("phone") ?? "";
  const customerName = form.get("customerName") ?? "Cliente";

  if (!channel || !phone) {
    res.status(400).send("Cliente inválido.");
    return;
  }

  if (action === "set_credit_limit") {
    const limit = parseMoneyInput(form.get("creditLimit"));
    await setCustomerCreditLimit({
      channel,
      phone,
      customerName,
      creditLimit: limit,
      note: null
    });
  } else if (action === "record_payment") {
    const amount = parseMoneyInput(form.get("paymentAmount")) ?? 0;

    if (amount <= 0) {
      res.status(400).send("Valor de pagamento inválido.");
      return;
    }

    await recordCustomerCreditPayment({
      channel,
      phone,
      customerName,
      amount,
      note: null
    });
  } else {
    res.status(400).send("Ação inválida.");
    return;
  }

  redirectToAdmin(res);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(date);
}

function formatDateOnly(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(date);
}

function formatOdd(value: number | null): string {
  if (!value) {
    return "-";
  }

  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    confirmado: "Confirmado",
    encontrado: "Localizado",
    nao_encontrado: "Não encontrado",
    codigo_nao_encontrado: "Código não identificado",
    erro: "Erro",
    limite_excedido: "Limite excedido",
    queued: "Na fila",
    processing: "Processando",
    todos: "Todos"
  };

  return labels[status] ?? status;
}

function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    todos: "Todos"
  };

  return labels[channel] ?? channel;
}

function adminNotificationChannelLabel(): string {
  return config.adminNotifications.channel === "whatsapp" ? "WhatsApp" : "Telegram";
}

function statusClass(status: string, confirmed = false): string {
  if (confirmed || status === "confirmado") {
    return "ok";
  }

  if (status === "erro" || status === "nao_encontrado" || status === "codigo_nao_encontrado" || status === "limite_excedido") {
    return "bad";
  }

  if (status === "processing" || status === "queued") {
    return "info";
  }

  return "warn";
}

function buildAdminUrl(data: AdminDashboardData, extra: Record<string, string>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries({
    q: data.filters.q,
    status: data.filters.status,
    channel: data.filters.channel,
    from: data.filters.from,
    to: data.filters.to,
    limit: String(data.filters.limit),
    ...extra
  })) {
    if (value && value !== "todos") {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return `/api/admin${query ? `?${query}` : ""}`;
}

function metric(label: string, value: string, detail: string): string {
  return `
    <section class="metric" aria-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </section>
  `;
}

function renderBreakdown(title: string, items: AdminBreakdown[], formatter: (label: string) => string): string {
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return `
    <section class="panel compact">
      <div class="section-heading">
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="breakdown">
        ${items.length === 0 ? `<p class="empty-text">Sem dados no filtro atual.</p>` : items.map((item) => {
          const width = total > 0 ? Math.max(6, Math.round((item.count / total) * 100)) : 0;

          return `
            <div class="breakdown-row">
              <div>
                <strong>${escapeHtml(formatter(item.label))}</strong>
                <small>${formatMoney(item.amount)} em apostas</small>
              </div>
              <span>${formatInteger(item.count)}</span>
              <div class="bar"><i style="width:${width}%"></i></div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderCustomerRows(customers: AdminCustomerSummary[]): string {
  if (customers.length === 0) {
    return `<tr><td colspan="16" class="empty">Nenhum cliente encontrado.</td></tr>`;
  }

  return customers.map((customer) => `
    <tr>
      <td data-label="Cliente"><strong>${escapeHtml(customer.customerName)}</strong></td>
      <td data-label="ID do cliente"><code>${escapeHtml(customer.customerId)}</code></td>
      <td data-label="Contato">
        ${escapeHtml(customer.contact)}
        <small>Celular: ${escapeHtml(customer.registeredPhone ?? "Não informado")}</small>
      </td>
      <td data-label="Canal">${escapeHtml(channelLabel(customer.channel))}</td>
      <td data-label="Bilhetes" class="num">${formatInteger(customer.tickets)}</td>
      <td data-label="Confirmados" class="num">${formatInteger(customer.confirmed)}</td>
      <td data-label="Jogos" class="num">${formatInteger(customer.games)}</td>
      <td data-label="Valor total" class="num">${formatMoney(customer.amount)}</td>
      <td data-label="Limite" class="num">${formatCreditMoney(customer.credit.limit)}</td>
      <td data-label="Em aberto" class="num">${formatMoney(customer.credit.outstanding)}</td>
      <td data-label="Disponível" class="num">${formatCreditMoney(customer.credit.available)}</td>
      <td data-label="Média por bilhete" class="num">${formatMoney(customer.averageTicketAmount)}</td>
      <td data-label="Média por jogo" class="num">${formatMoney(customer.averageGameAmount)}</td>
      <td data-label="Prêmio" class="num">${formatMoney(customer.prize)}</td>
      <td data-label="Último envio">
        ${formatDate(customer.lastActivity)}
        ${customer.lastTicketCode ? `<small>${escapeHtml(customer.lastTicketCode)}</small>` : ""}
      </td>
      <td data-label="Financeiro">
        <div class="money-actions">
          <form method="post" action="/api/admin">
            <input type="hidden" name="action" value="set_credit_limit">
            <input type="hidden" name="channel" value="${escapeHtml(customer.channel)}">
            <input type="hidden" name="phone" value="${escapeHtml(customer.contact)}">
            <input type="hidden" name="customerName" value="${escapeHtml(customer.customerName)}">
            <input name="creditLimit" inputmode="decimal" placeholder="Limite" value="${customer.credit.limit === null ? "" : escapeHtml(customer.credit.limit.toFixed(2).replace(".", ","))}">
            <button type="submit">Salvar</button>
          </form>
          <form method="post" action="/api/admin">
            <input type="hidden" name="action" value="record_payment">
            <input type="hidden" name="channel" value="${escapeHtml(customer.channel)}">
            <input type="hidden" name="phone" value="${escapeHtml(customer.contact)}">
            <input type="hidden" name="customerName" value="${escapeHtml(customer.customerName)}">
            <input name="paymentAmount" inputmode="decimal" placeholder="Valor pago">
            <button type="submit">Registrar</button>
          </form>
        </div>
        <small>Pago: ${formatMoney(customer.credit.payments)} · Reservado: ${formatMoney(customer.credit.reserved)}</small>
        <small>Pagamento registrado libera limite automaticamente.</small>
      </td>
    </tr>
  `).join("");
}

function renderGameCards(ticket: AdminTicket): string {
  if (ticket.games.length === 0) {
    return `<p class="empty-text">Sem jogos detalhados gravados para este bilhete.</p>`;
  }

  return `
    <div class="games">
      ${ticket.games.map((game, index) => `
        <article class="game">
          <div class="game-top">
            <span>Jogo ${index + 1}</span>
            <strong>${escapeHtml(formatOdd(game.odd))}</strong>
          </div>
          <div class="match">
            <strong>${escapeHtml(game.home || "-")}</strong>
            <span>x</span>
            <strong>${escapeHtml(game.away || "-")}</strong>
          </div>
          <dl class="game-fields">
            <div><dt>Data</dt><dd>${escapeHtml(game.date ? formatDate(game.date) : "-")}</dd></div>
            <div><dt>Esporte</dt><dd>${escapeHtml(game.sport || "-")}</dd></div>
            <div><dt>Mercado</dt><dd>${escapeHtml(game.market || "-")}</dd></div>
            <div><dt>Palpite</dt><dd>${escapeHtml(game.selection || "-")}</dd></div>
            <div><dt>Valor proporcional</dt><dd>${formatMoney(game.stakeShare)}</dd></div>
            <div><dt>Status</dt><dd>${escapeHtml(game.status || "-")}</dd></div>
            <div><dt>Resultado</dt><dd>${escapeHtml(game.result || "-")}</dd></div>
          </dl>
        </article>
      `).join("")}
    </div>
  `;
}

function renderTicketDeleteForm(ticket: AdminTicket): string {
  return `
    <form method="post" action="/api/admin" class="danger-form" onsubmit="return confirm('Apagar este registro do painel?');">
      <input type="hidden" name="action" value="delete_job">
      <input type="hidden" name="jobId" value="${escapeHtml(ticket.id)}">
      <label>
        <span>Senha do administrador</span>
        <input type="password" name="adminPassword" autocomplete="current-password" placeholder="Senha para apagar" required>
      </label>
      <button type="submit" class="danger-button">Apagar este registro</button>
    </form>
  `;
}

function renderTicketCard(ticket: AdminTicket): string {
  const deliveryText = [
    ticket.textSent ? "texto enviado" : "texto pendente",
    ticket.imageSent ? "imagem enviada" : "sem imagem"
  ].join(" · ");

  return `
    <article class="ticket">
      <div class="ticket-head">
        <div>
          <span class="code">${escapeHtml(ticket.ticketCode ?? ticket.siteTicketCode ?? "-")}</span>
          <h3>${escapeHtml(ticket.customerName)}</h3>
          <p>
            ${escapeHtml(channelLabel(ticket.channel))} · ${escapeHtml(ticket.contact)}
            ${ticket.username ? ` · @${escapeHtml(ticket.username)}` : ""}
            ${ticket.registeredPhone ? ` · Celular: ${escapeHtml(ticket.registeredPhone)}` : ""}
          </p>
          <small>ID do cliente: ${escapeHtml(ticket.customerId)}</small>
        </div>
        <span class="pill ${statusClass(ticket.status, ticket.confirmed)}">${escapeHtml(statusLabel(ticket.status))}</span>
      </div>

      <dl class="ticket-grid">
        <div><dt>Recebido</dt><dd>${formatDate(ticket.createdAt)}</dd></div>
        <div><dt>Processado</dt><dd>${formatDate(ticket.processedAt)}</dd></div>
        <div><dt>Celular cadastrado</dt><dd>${escapeHtml(ticket.registeredPhone ?? "-")}</dd></div>
        <div><dt>Cliente no site</dt><dd>${escapeHtml(ticket.siteCustomerName ?? "-")}</dd></div>
        <div><dt>Status no site</dt><dd>${escapeHtml(ticket.siteStatus ?? "-")}</dd></div>
        <div><dt>Valor</dt><dd>${formatMoney(ticket.amount)}</dd></div>
        <div><dt>Prêmio possível</dt><dd>${formatMoney(ticket.prize)}</dd></div>
        <div><dt>Jogos</dt><dd>${formatInteger(ticket.gameCount)}</dd></div>
        <div><dt>Média por jogo</dt><dd>${formatMoney(ticket.averageGameAmount)}</dd></div>
        <div><dt>Confirmação</dt><dd>${escapeHtml(ticket.confirmationCode ?? "-")}</dd></div>
      </dl>

      <details>
        <summary>Detalhes completos</summary>
        ${renderGameCards(ticket)}
        <dl class="message-grid">
          <div><dt>Mensagem recebida</dt><dd>${escapeHtml(ticket.originalMessage || "-")}</dd></div>
          <div><dt>Mensagem enviada</dt><dd>${escapeHtml(ticket.customerMessage ?? "-")}</dd></div>
          <div><dt>Entrega</dt><dd>${escapeHtml(deliveryText)}</dd></div>
          <div><dt>ID externo</dt><dd>${escapeHtml(ticket.externalMessageId ?? "-")}</dd></div>
          ${ticket.errorMessage ? `<div><dt>Erro</dt><dd>${escapeHtml(ticket.errorMessage)}</dd></div>` : ""}
          ${ticket.deliveryError ? `<div><dt>Erro de entrega</dt><dd>${escapeHtml(ticket.deliveryError)}</dd></div>` : ""}
        </dl>
        ${renderTicketDeleteForm(ticket)}
      </details>
    </article>
  `;
}

function renderTickets(tickets: AdminTicket[]): string {
  if (tickets.length === 0) {
    return `<div class="empty-block">Nenhum bilhete encontrado para os filtros atuais.</div>`;
  }

  return tickets.map(renderTicketCard).join("");
}

function renderFilters(data: AdminDashboardData): string {
  return `
    <form method="get" action="/api/admin" class="filters">
      <label>
        <span>Busca</span>
        <input name="q" value="${escapeHtml(data.filters.q)}" placeholder="Cliente, celular, contato ou bilhete" autocomplete="off">
      </label>
      <label>
        <span>Status</span>
        <select name="status">
          ${STATUSES.map((status) => `
            <option value="${status}" ${data.filters.status === status ? "selected" : ""}>${statusLabel(status)}</option>
          `).join("")}
        </select>
      </label>
      <label>
        <span>Canal</span>
        <select name="channel">
          ${CHANNELS.map((channel) => `
            <option value="${channel}" ${data.filters.channel === channel ? "selected" : ""}>${channelLabel(channel)}</option>
          `).join("")}
        </select>
      </label>
      <label>
        <span>De</span>
        <input name="from" type="date" value="${escapeHtml(data.filters.from)}">
      </label>
      <label>
        <span>Até</span>
        <input name="to" type="date" value="${escapeHtml(data.filters.to)}">
      </label>
      <label>
        <span>Limite</span>
        <select name="limit">
          ${[50, 100, 200, 500].map((limit) => `
            <option value="${limit}" ${data.filters.limit === limit ? "selected" : ""}>${limit}</option>
          `).join("")}
        </select>
      </label>
      <button type="submit">Filtrar</button>
      <a class="button secondary" href="/api/admin">Limpar</a>
      <a class="button ghost" href="${escapeHtml(buildAdminUrl(data, { format: "json" }))}">Exportar JSON</a>
    </form>
  `;
}

function renderNotice(notice: string): string {
  if (!notice) {
    return "";
  }

  return `<div class="notice" role="status">${escapeHtml(notice)}</div>`;
}

function renderAdminNotificationsPanel(targetCount: number): string {
  const channel = adminNotificationChannelLabel();
  const description = config.adminNotifications.channel === "whatsapp"
    ? "As notificacoes administrativas serao enviadas para os numeros configurados no ambiente. Use o teste abaixo para validar o recebimento."
    : "Para ativar neste Telegram, abra o bot do administrador e envie <code>/admin sua-senha-do-painel</code>. Depois use o teste abaixo.";

  return `
    <section class="panel notify-panel" aria-label="Notificacoes administrativas">
      <div>
        <span class="eyebrow">Notificacoes reais</span>
        <h2>${escapeHtml(channel)} do administrador</h2>
        <p class="muted">${description}</p>
        <small>${formatInteger(targetCount)} destino(s) administrativo(s) ativo(s) via ${escapeHtml(channel)}.</small>
      </div>
      <form method="post" action="/api/admin" class="notify-form">
        <input type="hidden" name="action" value="send_admin_notification_test">
        <label>
          <span>Senha do administrador</span>
          <input type="password" name="adminPassword" autocomplete="current-password" placeholder="Senha para testar" required>
        </label>
        <button type="submit">Enviar teste</button>
      </form>
    </section>
  `;
}

function renderCleanupPanel(data: AdminDashboardData): string {
  return `
    <section class="panel cleanup-panel" aria-label="Limpeza operacional">
      <div>
        <span class="eyebrow">Limpeza operacional</span>
        <h2>Apagar testes do painel</h2>
        <p class="muted">
          Remove bilhetes, clientes, pagamentos, limites e contatos cadastrados. A estrutura do banco, o administrador e os logs de seguranca continuam preservados.
        </p>
        <small>${formatInteger(data.totals.tickets)} bilhete(s) e ${formatInteger(data.totals.customers)} cliente(s) visiveis agora.</small>
      </div>
      <form method="post" action="/api/admin" class="cleanup-form" onsubmit="return confirm('Limpar todos os dados operacionais do painel?');">
        <input type="hidden" name="action" value="clear_operational_data">
        <label>
          <span>Senha do administrador</span>
          <input type="password" name="adminPassword" autocomplete="current-password" placeholder="Confirme com a senha" required>
        </label>
        <button type="submit" class="danger-button">Limpar tudo</button>
      </form>
    </section>
  `;
}

function renderHtml(data: AdminDashboardData, options: { notice: string; adminNotificationTargets: number }): string {
  const averageTicket = data.totals.tickets > 0 ? data.totals.amount / data.totals.tickets : 0;
  const lastUpdate = formatDate(data.generatedAt);
  const dataUrl = buildAdminUrl(data, { format: "json" });

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Admin - Validador de Bilhetes</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-soft: #f9fafb;
      --text: #151923;
      --muted: #687385;
      --line: #d9dee7;
      --line-strong: #c5ccd8;
      --accent: #0f766e;
      --accent-dark: #115e59;
      --ok: #137333;
      --ok-bg: #e7f6ec;
      --bad: #b42318;
      --bad-bg: #fde8e7;
      --warn: #945a00;
      --warn-bg: #fff3d6;
      --info: #155eef;
      --info-bg: #e8efff;
      --shadow: 0 1px 2px rgba(16, 24, 40, .06);
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      max-width: 100%;
      overflow-x: hidden;
    }
    html { min-width: 320px; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Arial, Helvetica, sans-serif;
      letter-spacing: 0;
    }

    main, section, article, div, form, table, tbody, tr, td, dl, dd {
      min-width: 0;
    }
    p, h1, h2, h3, span, strong, small, a, button, input, select, dd, td {
      overflow-wrap: anywhere;
    }
    a { color: inherit; }
    .page {
      width: min(1480px, calc(100% - 32px));
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    .topbar {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 16px;
    }
    .eyebrow {
      color: var(--muted);
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.15; }
    h2 { font-size: 16px; line-height: 1.25; }
    h3 { font-size: 16px; line-height: 1.25; margin-top: 4px; }
    .muted, small { color: var(--muted); }
    small { font-size: 12px; }
    code {
      color: var(--accent-dark);
      font: 700 12px/1.4 "Courier New", monospace;
      overflow-wrap: anywhere;
    }

    .panel, .metric, .ticket {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .panel { padding: 14px; }
    .panel.compact { min-height: 100%; }
    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 2fr) repeat(5, minmax(120px, 1fr)) auto auto auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
    }
    .cleanup-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
      gap: 14px;
      align-items: end;
      margin-bottom: 14px;
      border-color: #f3c3bd;
      background: #fffafa;
    }
    .cleanup-panel h2 {
      color: var(--bad);
      margin-bottom: 5px;
    }
    .cleanup-panel p {
      max-width: 760px;
      margin-bottom: 6px;
    }
    .notify-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
      gap: 14px;
      align-items: end;
      margin-bottom: 14px;
      border-color: #b6ded8;
      background: #f7fcfb;
    }
    .notify-panel h2 {
      color: var(--accent-dark);
      margin-bottom: 5px;
    }
    .notify-panel p {
      max-width: 760px;
      margin-bottom: 6px;
    }
    .notify-form {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .notice {
      border: 1px solid #b6ded8;
      border-radius: 8px;
      background: #edf7f5;
      color: var(--accent-dark);
      font-weight: 800;
      margin-bottom: 14px;
      padding: 10px 12px;
    }
    .cleanup-form, .danger-form {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .danger-form {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #f3c3bd;
      grid-template-columns: minmax(180px, 260px) auto;
      align-items: end;
    }
    .danger-button {
      background: var(--bad);
      border-color: var(--bad);
      color: #ffffff;
      font-weight: 800;
    }
    .danger-button:hover {
      background: #8f1f16;
      border-color: #8f1f16;
    }
    label span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    input, select, button, .button {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      min-height: 38px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      letter-spacing: 0;
      padding: 8px 10px;
    }
    button, .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
    }
    button, .button.secondary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
      font-weight: 700;
    }
    .button.secondary { background: #334155; border-color: #334155; }
    .button.ghost { color: var(--accent-dark); background: #edf7f5; border-color: #b6ded8; font-weight: 700; }

    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric { padding: 13px; min-height: 92px; }
    .metric span { color: var(--muted); display: block; font-size: 12px; }
    .metric strong { display: block; font-size: 22px; line-height: 1.15; margin-top: 5px; }
    .metric small { display: block; margin-top: 6px; }

    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 18px;
    }
    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 10px;
    }
    .breakdown { display: grid; gap: 10px; }
    .breakdown-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 12px;
      align-items: center;
    }
    .breakdown-row strong { display: block; }
    .breakdown-row span { font-weight: 700; }
    .bar {
      grid-column: 1 / -1;
      height: 7px;
      background: #edf0f4;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar i { display: block; height: 100%; background: var(--accent); border-radius: inherit; }

    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
      margin-bottom: 20px;
    }
    table { width: 100%; min-width: 0; table-layout: fixed; border-collapse: collapse; }
    th, td { padding: 10px 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th {
      position: sticky;
      top: 0;
      background: #eef1f5;
      color: #475467;
      font-size: 12px;
      text-transform: uppercase;
      z-index: 1;
    }
    td strong { display: block; }
    td small { display: block; margin-top: 3px; }
    .num { text-align: right; white-space: nowrap; }
    .money-actions {
      display: grid;
      gap: 6px;
      min-width: 0;
      width: 100%;
    }
    .money-actions form {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      align-items: center;
    }
    .money-actions input,
    .money-actions button {
      min-height: 32px;
      padding: 6px 8px;
      font-size: 12px;
    }
    .money-actions button {
      width: 100%;
      min-width: 0;
    }
    .empty, .empty-block, .empty-text {
      color: var(--muted);
      text-align: center;
    }
    .empty-block {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
    }

    .tickets {
      display: grid;
      gap: 12px;
    }
    .ticket { padding: 14px; }
    .ticket-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
      margin-bottom: 12px;
    }
    .ticket-head > div { min-width: 0; }
    .ticket-head p { color: var(--muted); margin-top: 4px; }
    .code {
      display: inline-block;
      color: var(--accent-dark);
      font-weight: 800;
      letter-spacing: .04em;
      word-break: break-word;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      border-radius: 999px;
      min-height: 26px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 800;
      text-align: center;
    }
    .pill.ok { color: var(--ok); background: var(--ok-bg); }
    .pill.bad { color: var(--bad); background: var(--bad-bg); }
    .pill.warn { color: var(--warn); background: var(--warn-bg); }
    .pill.info { color: var(--info); background: var(--info-bg); }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      border: 1px solid #b6ded8;
      border-radius: 999px;
      background: #edf7f5;
      color: var(--accent-dark);
      font-weight: 800;
      padding: 6px 11px;
      white-space: nowrap;
    }
    .live::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 4px rgba(15, 118, 110, .12);
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
      min-width: 0;
    }
    .logout {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      background: var(--surface);
      color: #334155;
      font-weight: 800;
      padding: 6px 13px;
      text-decoration: none;
      white-space: nowrap;
    }
    .logout:hover {
      border-color: #f5b9b4;
      background: var(--bad-bg);
      color: var(--bad);
    }

    dl { margin: 0; }
    dt { color: var(--muted); font-size: 12px; margin-bottom: 2px; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .ticket-grid, .game-fields, .message-grid {
      display: grid;
      gap: 10px;
    }
    .ticket-grid { grid-template-columns: repeat(4, minmax(150px, 1fr)); margin-bottom: 12px; }
    .ticket-grid > div, .message-grid > div {
      background: var(--surface-soft);
      border: 1px solid #edf0f4;
      border-radius: 6px;
      padding: 9px;
    }
    details {
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    summary {
      color: var(--accent-dark);
      cursor: pointer;
      font-weight: 800;
      min-height: 30px;
      overflow-wrap: anywhere;
    }
    .games {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
      gap: 10px;
      margin: 10px 0 12px;
    }
    .game {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 11px;
      background: #ffffff;
    }
    .game-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .game-top strong { color: var(--text); font-size: 14px; }
    .match {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
    }
    .match strong { min-width: 0; overflow-wrap: anywhere; }
    .match strong:last-child { text-align: right; }
    .match span { color: var(--muted); }
    .game-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .message-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

    @media (max-width: 1180px) {
      .filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .metrics { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
      .ticket-grid { grid-template-columns: repeat(2, minmax(150px, 1fr)); }
    }
    @media (max-width: 820px) {
      .page { width: min(100% - 16px, 720px); padding-top: 14px; padding-bottom: 26px; }
      .topbar { align-items: stretch; flex-direction: column; gap: 10px; }
      .top-actions { justify-content: flex-start; width: 100%; }
      .live, .logout { flex: 1 1 130px; }
      h1 { font-size: 22px; }
      .filters, .notify-panel, .cleanup-panel, .metrics, .split, .ticket-grid, .message-grid { grid-template-columns: 1fr; }
      .filters {
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .metric { min-height: auto; }
      .table-wrap { overflow: visible; border: 0; background: transparent; box-shadow: none; }
      table, thead, tbody, tr, th, td { display: block; width: 100%; min-width: 0; }
      thead { display: none; }
      tr {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        margin-bottom: 10px;
        overflow: hidden;
      }
      td {
        display: grid;
        grid-template-columns: minmax(92px, 34%) minmax(0, 1fr);
        gap: 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
      }
      td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      td:last-child { border-bottom: 0; }
      .num { text-align: left; }
      td[data-label="Financeiro"] {
        display: block;
      }
      td[data-label="Financeiro"]::before {
        display: block;
        margin-bottom: 8px;
      }
      .money-actions {
        min-width: 0;
        width: 100%;
      }
      .money-actions form {
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .danger-form {
        grid-template-columns: 1fr;
      }
      .money-actions input {
        min-width: 0;
      }
      .ticket-head { flex-direction: column; }
      .ticket, .panel, .game { padding: 12px; }
      .game-fields { grid-template-columns: 1fr; }
      .match { grid-template-columns: 1fr; }
      .match strong:last-child { text-align: left; }
    }
    @media (max-width: 420px) {
      .page { width: min(100% - 12px, 720px); }
      h1 { font-size: 20px; }
      .metric strong { font-size: 20px; }
      td {
        display: block;
        padding: 10px;
      }
      td::before {
        display: block;
        margin-bottom: 4px;
      }
      .money-actions form {
        grid-template-columns: 1fr;
      }
      .danger-form {
        grid-template-columns: 1fr;
      }
      .money-actions button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="topbar">
      <div>
        <span class="eyebrow">Painel administrativo</span>
        <h1>Validador de Bilhetes</h1>
        <p class="muted">Atualizado em <span id="last-update">${lastUpdate}</span></p>
      </div>
      <div class="top-actions">
        <span class="live" id="live-status">Ao vivo</span>
        <a class="logout" href="/admin/logout">Sair</a>
      </div>
    </header>

    ${renderFilters(data)}
    ${renderNotice(options.notice)}
    ${renderAdminNotificationsPanel(options.adminNotificationTargets)}
    ${renderCleanupPanel(data)}

    <section class="metrics" aria-label="Indicadores">
      ${metric("Bilhetes", formatInteger(data.totals.tickets), `${formatInteger(data.totals.customers)} cliente(s)`)}
      ${metric("Confirmados", formatInteger(data.totals.confirmed), `${formatInteger(data.totals.deliveredText)} resposta(s) enviada(s)`)}
      ${metric("Localizados", formatInteger(data.totals.found), `${formatInteger(data.totals.notFound)} não localizado(s)`)}
      ${metric("Valor total geral", formatMoney(data.totals.amount), `Média por bilhete ${formatMoney(averageTicket)}`)}
      ${metric("Prêmio possível", formatMoney(data.totals.prize), `${formatInteger(data.totals.games)} jogo(s)`)}
      ${metric("Média por jogo", formatMoney(data.totals.averageGameAmount), `${formatInteger(data.totals.deliveredImage)} comprovante(s)`)}
    </section>

    <section class="split">
      ${renderBreakdown("Status dos bilhetes", data.statusBreakdown, statusLabel)}
      ${renderBreakdown("Canais de entrada", data.channelBreakdown, channelLabel)}
    </section>

    <section>
      <div class="section-heading">
        <h2>Resumo por cliente</h2>
        <span class="muted">${formatInteger(data.customers.length)} cliente(s)</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>ID do cliente</th>
              <th>Contato</th>
              <th>Canal</th>
              <th>Bilhetes</th>
              <th>Confirmados</th>
              <th>Jogos</th>
              <th>Valor total</th>
              <th>Limite</th>
              <th>Em aberto</th>
              <th>Disponível</th>
              <th>Média bilhete</th>
              <th>Média jogo</th>
              <th>Prêmio</th>
              <th>Último envio</th>
              <th>Financeiro</th>
            </tr>
          </thead>
          <tbody>${renderCustomerRows(data.customers)}</tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="section-heading">
        <h2>Bilhetes e jogos</h2>
        <span class="muted">${formatInteger(data.tickets.length)} registro(s)</span>
      </div>
      <div class="tickets">${renderTickets(data.tickets)}</div>
    </section>
  </main>
  <script>
    (() => {
      const currentVersion = ${JSON.stringify(data.version)};
      const dataUrl = ${JSON.stringify(dataUrl)};
      const status = document.getElementById("live-status");
      const lastUpdate = document.getElementById("last-update");

      async function checkForUpdates() {
        try {
          const response = await fetch(dataUrl, {
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
          });

          if (!response.ok) {
            if (status) status.textContent = "Reconectando";
            return;
          }

          const data = await response.json();

          if (data.version !== currentVersion) {
            window.location.reload();
            return;
          }

          if (status) status.textContent = "Ao vivo";
          if (lastUpdate && data.generatedAt) {
            lastUpdate.textContent = new Intl.DateTimeFormat("pt-BR", {
              dateStyle: "short",
              timeStyle: "short",
              timeZone: "America/Sao_Paulo"
            }).format(new Date(data.generatedAt));
          }
        } catch {
          if (status) status.textContent = "Reconectando";
        }
      }

      window.setInterval(checkForUpdates, 8000);
    })();
  </script>
</body>
</html>`;
}

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (!config.admin.username || !config.admin.password) {
    res.status(503).send("ADMIN_USERNAME e ADMIN_PASSWORD precisam estar configurados.");
    return;
  }

  if (!isAdminRequestAuthorized(req.headers)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Validador Admin", charset="UTF-8"');
    res.status(401).send("Autenticação obrigatória.");
    return;
  }

  try {
    if (req.method === "POST") {
      await handleAdminAction(req, res);
      return;
    }

    if (req.method && req.method !== "GET") {
      res.status(405).send("Metodo nao permitido.");
      return;
    }

    const params = requestSearchParams(req);
    const notice = searchParamValue(params, "notice");
    const data = await loadAdminDashboardData({
      q: searchParamValue(params, "q"),
      status: searchParamValue(params, "status") || "todos",
      channel: searchParamValue(params, "channel") || "todos",
      from: searchParamValue(params, "from"),
      to: searchParamValue(params, "to"),
      limit: Number.parseInt(searchParamValue(params, "limit") || "100", 10)
    });

    if (searchParamValue(params, "format") === "json") {
      res.status(200).json(data);
      return;
    }

    const adminNotificationTargets = await countAdminNotificationTargets();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderHtml(data, { notice, adminNotificationTargets }));
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao carregar o painel administrativo.");
  }
}
