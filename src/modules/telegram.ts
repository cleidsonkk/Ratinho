import { config } from "../config.js";
import { log } from "../logger.js";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramReplyMarkup = Record<string, unknown>;

function requireBotToken(): string {
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN nao configurado");
  }

  return config.telegram.botToken;
}

async function callTelegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = requireBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => null)) as TelegramResponse<T> | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} retornou ${response.status}: ${payload?.description ?? "erro desconhecido"}`);
  }

  return payload.result as T;
}

export class TelegramClient {
  async sendText(chatId: string, text: string, options: { replyMarkup?: TelegramReplyMarkup } = {}): Promise<void> {
    if (!config.telegram.botToken) {
      log("info", "Telegram sem token: texto nao enviado", { chatId, text });
      return;
    }

    await callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
  }

  async requestContact(chatId: string, text: string): Promise<void> {
    await this.sendText(chatId, text, {
      replyMarkup: {
        keyboard: [[{ text: "Compartilhar meu telefone", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: "Envie o codigo do bilhete"
      }
    });
  }

  async sendImage(chatId: string, imageBase64: string, caption: string): Promise<void> {
    if (!config.telegram.botToken) {
      log("info", "Telegram sem token: imagem nao enviada", {
        chatId,
        caption,
        bytesBase64: imageBase64.length
      });
      return;
    }

    const token = requireBotToken();
    const buffer = Buffer.from(imageBase64, "base64");
    const formData = new FormData();

    formData.append("chat_id", chatId);
    formData.append("caption", caption);
    formData.append("photo", new Blob([buffer], { type: "image/png" }), "comprovante-bilhete.png");

    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: formData
    });

    const payload = (await response.json().catch(() => null)) as TelegramResponse<unknown> | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(`Telegram sendPhoto retornou ${response.status}: ${payload?.description ?? "erro desconhecido"}`);
    }
  }
}
