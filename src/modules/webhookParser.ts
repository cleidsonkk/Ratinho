import type { InboundMessage } from "../types.js";

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizePhone(raw: string): string {
  const remoteJid = raw.split("@")[0] ?? raw;
  return remoteJid.replace(/\D/g, "");
}

function firstMetaMessage(payload: Record<string, any>): Record<string, any> | null {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      const message = messages[0];

      if (message && typeof message === "object") {
        return message;
      }
    }
  }

  return null;
}

export function parseInboundWhatsAppMessage(body: unknown): InboundMessage | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const payload = body as Record<string, any>;
  const metaMessage = firstMetaMessage(payload);
  const data = payload.data ?? {};
  const message = metaMessage ?? data.message ?? payload.message ?? {};
  const key = data.key ?? payload.key ?? {};

  const rawNumber = pickString(
    metaMessage?.from,
    payload.numero,
    payload.number,
    payload.phone,
    payload.from,
    payload.remoteJid,
    data.numero,
    data.number,
    data.phone,
    data.from,
    data.remoteJid,
    key.remoteJid
  );

  const text = pickString(
    payload.mensagem,
    payload.text,
    payload.body,
    payload.message,
    data.mensagem,
    data.text,
    data.body,
    message.conversation,
    message.text,
    message?.text?.body,
    message?.extendedTextMessage?.text,
    message?.ephemeralMessage?.message?.extendedTextMessage?.text,
    message?.ephemeralMessage?.message?.conversation
  );

  const numero = normalizePhone(rawNumber);
  const externalMessageId = pickString(
    payload.messageId,
    payload.id,
    data.messageId,
    data.id,
    metaMessage?.id,
    key.id,
    message.id
  );

  if (!numero || !text) {
    return null;
  }

  return {
    channel: "whatsapp",
    recipientId: numero,
    mensagem: text,
    externalMessageId: externalMessageId || null,
    raw: body
  };
}
