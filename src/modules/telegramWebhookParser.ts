import type { InboundMessage } from "../types.js";

function pickTelegramText(message: Record<string, any>): string {
  const text = message.text;
  const caption = message.caption;

  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }

  if (typeof caption === "string" && caption.trim()) {
    return caption.trim();
  }

  return "";
}

export function parseInboundTelegramMessage(body: unknown): InboundMessage | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const update = body as Record<string, any>;
  const message = update.message ?? update.edited_message ?? update.channel_post;

  if (!message || typeof message !== "object") {
    return null;
  }

  const chatId = message.chat?.id;
  const contact = message.contact;
  const text = pickTelegramText(message) || (contact ? "/contact" : "");

  if ((typeof chatId !== "number" && typeof chatId !== "string") || !text) {
    return null;
  }

  const contactPhone = typeof contact?.phone_number === "string" ? contact.phone_number : null;
  const contactFirstName = typeof contact?.first_name === "string" ? contact.first_name : null;
  const contactLastName = typeof contact?.last_name === "string" ? contact.last_name : null;

  return {
    channel: "telegram",
    recipientId: String(chatId),
    mensagem: text,
    externalMessageId: update.update_id !== undefined ? `telegram:${update.update_id}` : null,
    raw: body,
    contactPhone,
    contactFirstName,
    contactLastName
  };
}
