import { randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { recordSecurityEvent } from "./persistence.js";

export type RequestSecurityContext = {
  ip: string;
  userAgent: string;
  getHeader: (name: string) => string | undefined | null;
};

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function isAllowedIp(ip: string): boolean {
  return config.webhookAllowedIps.length === 0 || config.webhookAllowedIps.includes(ip);
}

export async function authorizeRequest(context: RequestSecurityContext): Promise<boolean> {
  if (!isAllowedIp(context.ip)) {
    await deny("ip_nao_permitido", context, { ip: context.ip });
    return false;
  }

  if (!config.webhookSecret) {
    log("warn", "WEBHOOK_SECRET não configurado; webhook sem segredo compartilhado");
    return true;
  }

  const received = context.getHeader("x-webhook-secret") ?? "";

  if (!safeEqual(received, config.webhookSecret)) {
    await deny("segredo_invalido", context, {});
    return false;
  }

  return true;
}

export async function authorizeTelegramRequest(context: RequestSecurityContext): Promise<boolean> {
  if (!isAllowedIp(context.ip)) {
    await deny("ip_nao_permitido", context, { ip: context.ip, channel: "telegram" });
    return false;
  }

  if (!config.telegram.webhookSecret) {
    log("warn", "TELEGRAM_WEBHOOK_SECRET nao configurado; webhook Telegram sem segredo compartilhado");
    return true;
  }

  const received = context.getHeader("x-telegram-bot-api-secret-token") ?? "";

  if (!safeEqual(received, config.telegram.webhookSecret)) {
    await deny("telegram_segredo_invalido", context, {});
    return false;
  }

  return true;
}

async function deny(eventType: string, context: RequestSecurityContext, metadata: Record<string, unknown>): Promise<void> {
  log("warn", "Requisição bloqueada por regra de segurança", {
    eventType,
    ip: context.ip
  });

  await recordSecurityEvent({
    id: randomUUID(),
    eventType,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata
  }).catch(() => undefined);
}
