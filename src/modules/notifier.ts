import type { ValidationJob } from "../types.js";
import { TelegramClient } from "./telegram.js";
import { WhatsAppClient } from "./whatsapp.js";

const whatsapp = new WhatsAppClient();
const telegram = new TelegramClient();

export async function sendText(channel: ValidationJob["channel"], recipientId: string, text: string): Promise<void> {
  if (channel === "telegram") {
    await telegram.sendText(recipientId, text);
    return;
  }

  await whatsapp.sendText(recipientId, text);
}

export async function sendImage(channel: ValidationJob["channel"], recipientId: string, imageBase64: string, caption: string): Promise<void> {
  if (channel === "telegram") {
    await telegram.sendImage(recipientId, imageBase64, caption);
    return;
  }

  await whatsapp.sendImage(recipientId, imageBase64, caption);
}

export async function requestTelegramContact(recipientId: string, text: string): Promise<void> {
  await telegram.requestContact(recipientId, text);
}
