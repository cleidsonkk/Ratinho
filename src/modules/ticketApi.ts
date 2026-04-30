import { config } from "../config.js";

export type SiteTicketData = Record<string, any>;

type LookupResult =
  | { found: true; data: SiteTicketData; source: "aposta" | "bolao" }
  | { found: false; status: number | null; error: string | null };

type ConfirmResult =
  | { confirmed: true; code: string | null; data: SiteTicketData; receiptPath: string }
  | { confirmed: false; status: number | null; error: string | null; data: unknown };

function compactCode(codigo: string): string {
  return codigo.replace(/\s+/g, "").toUpperCase();
}

function authHeaders(codigo: string): Record<string, string> {
  return {
    AUTHTOKEN: config.targetSite.authToken,
    ID: config.targetSite.userId,
    COD: codigo,
    "Content-Type": "application/json; charset=utf-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: config.targetUrl
  };
}

function sessionHeaders(codigo: string): Record<string, string> {
  return {
    ...authHeaders(codigo),
    IP: config.targetSite.ip,
    RTOKEN: config.targetSite.rToken,
    DTOKEN: config.targetSite.dToken || ""
  };
}

async function requestTicket(path: string, codigo: string): Promise<{ status: number; data: unknown; text: string }> {
  const response = await fetch(`${config.targetSite.apiBaseUrl}${path}`, {
    method: "GET",
    headers: authHeaders(codigo)
  });

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  return {
    status: response.status,
    data,
    text
  };
}

function isTicketData(data: unknown): data is SiteTicketData {
  if (!data || typeof data !== "object") {
    return false;
  }

  const payload = data as Record<string, any>;
  return Boolean(payload.aposta?.codigo || payload.aposta?.apost_id);
}

export function hasTargetLogin(): boolean {
  return Boolean(config.targetSite.authToken && config.targetSite.userId !== "0");
}

export function canConfirmTicket(): boolean {
  return Boolean(hasTargetLogin() && config.targetSite.rToken && config.targetSite.ip);
}

export async function lookupTicket(codigo: string): Promise<LookupResult> {
  const variants = [codigo.toUpperCase(), compactCode(codigo)];
  let lastStatus: number | null = null;
  let lastError: string | null = null;

  for (const variant of variants) {
    const aposta = await requestTicket("/api/Caixa/DetalheAposta/0", variant);
    lastStatus = aposta.status;
    lastError = aposta.text.slice(0, 500) || null;

    if (aposta.status === 200 && isTicketData(aposta.data)) {
      return { found: true, data: aposta.data, source: "aposta" };
    }

    if (aposta.status !== 404) {
      continue;
    }

    const bolao = await requestTicket("/api/CaixaBolao/DetalheAposta/0", variant);
    lastStatus = bolao.status;
    lastError = bolao.text.slice(0, 500) || null;

    if (bolao.status === 200 && isTicketData(bolao.data)) {
      return { found: true, data: bolao.data, source: "bolao" };
    }
  }

  return { found: false, status: lastStatus, error: lastError };
}

function ticketStatus(data: SiteTicketData): number | null {
  const status = data.aposta?.status;
  return typeof status === "number" ? status : null;
}

function ticketStatusDescription(data: SiteTicketData): string {
  const statusDescription = data.aposta?.status_desc;

  if (typeof statusDescription === "string" && statusDescription.trim()) {
    return statusDescription.trim();
  }

  const status = ticketStatus(data);
  return status === null ? "desconhecido" : String(status);
}

function confirmationCode(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as Record<string, any>;
  const code = payload.Codigo ?? payload.codigo ?? payload.CODIGO ?? payload.cod ?? payload.aposta?.codigo;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : null;
}

function confirmationItems(data: SiteTicketData): Array<Record<string, unknown>> {
  const items = Array.isArray(data.itens) ? data.itens : [];

  return items
    .map((item) => ({
      camp_jog_id: item?.camp_jog_id,
      jog_odd_id: item?.jog_odd_id,
      esporte_id: item?.esporte_id
    }))
    .filter((item) => item.camp_jog_id !== null && item.camp_jog_id !== undefined && item.camp_jog_id !== ""
      && item.jog_odd_id !== null && item.jog_odd_id !== undefined && item.jog_odd_id !== ""
      && item.esporte_id !== null && item.esporte_id !== undefined && item.esporte_id !== "");
}

async function postConfirmation(path: string, codigo: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown; text: string }> {
  const response = await fetch(`${config.targetSite.apiBaseUrl}${path}`, {
    method: "POST",
    headers: sessionHeaders(codigo),
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  return {
    status: response.status,
    data,
    text
  };
}

export async function confirmTicket(codigo: string, data: SiteTicketData, source: "aposta" | "bolao"): Promise<ConfirmResult> {
  if (!canConfirmTicket()) {
    return {
      confirmed: false,
      status: null,
      error: "Sessao de login incompleta para confirmar pre-bilhete",
      data: null
    };
  }

  if (ticketStatus(data) !== -2) {
    return {
      confirmed: false,
      status: null,
      error: `Bilhete localizado, mas nao esta pendente de confirmacao. Status: ${ticketStatusDescription(data)}`,
      data
    };
  }

  const normalizedCode = compactCode(codigo);
  const body: Record<string, unknown> = {
    ID: 0,
    Codigo: normalizedCode,
    Origem: 5
  };

  const path = source === "bolao" ? "/api/bolao/ConfirmaPreBilhete/" : "/api/Aposta/ConfirmaPreBilhete/";

  if (source === "aposta") {
    const jogos = confirmationItems(data);

    if (jogos.length === 0) {
      return {
        confirmed: false,
        status: null,
        error: "Bilhete sem jogos validos para confirmar",
        data
      };
    }

    body.jogos = jogos;
  }

  const response = await postConfirmation(path, normalizedCode, body);
  const code = confirmationCode(response.data);

  if (response.status === 200 && code) {
    return {
      confirmed: true,
      code,
      data: response.data as SiteTicketData,
      receiptPath: source === "bolao" ? `/jogos/impbol.aspx?cod=${encodeURIComponent(code)}` : `/jogos/imp.aspx?cod=${encodeURIComponent(code)}`
    };
  }

  return {
    confirmed: false,
    status: response.status,
    error: response.text.slice(0, 500) || "Confirmacao nao concluida",
    data: response.data
  };
}
