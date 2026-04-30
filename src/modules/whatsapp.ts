import { config } from "../config.js";
import { log } from "../logger.js";

type JsonObject = Record<string, unknown>;

async function postJson(url: string, body: JsonObject, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WhatsApp API retornou ${response.status}: ${text.slice(0, 500)}`);
  }
}

function requireConfig(value: string, name: string): string {
  if (!value) {
    throw new Error(`Configuração obrigatória ausente: ${name}`);
  }

  return value;
}

export class WhatsAppClient {
  async sendText(numero: string, text: string): Promise<void> {
    const provider = config.whatsapp.provider;

    if (provider === "none") {
      log("info", "WhatsApp provider none: texto não enviado", { numero, text });
      return;
    }

    if (provider === "evolution") {
      await this.sendEvolutionText(numero, text);
      return;
    }

    if (provider === "zapi") {
      await this.sendZapiText(numero, text);
      return;
    }

    if (provider === "meta") {
      await this.sendMetaText(numero, text);
      return;
    }

    throw new Error(`WHATSAPP_PROVIDER inválido: ${provider}`);
  }

  async sendImage(numero: string, imageBase64: string, caption: string): Promise<void> {
    const provider = config.whatsapp.provider;

    if (provider === "none") {
      log("info", "WhatsApp provider none: imagem não enviada", {
        numero,
        caption,
        bytesBase64: imageBase64.length
      });
      return;
    }

    if (provider === "evolution") {
      await this.sendEvolutionImage(numero, imageBase64, caption);
      return;
    }

    if (provider === "zapi") {
      await this.sendZapiImage(numero, imageBase64, caption);
      return;
    }

    if (provider === "meta") {
      await this.sendMetaImage(numero, imageBase64, caption);
      return;
    }

    throw new Error(`WHATSAPP_PROVIDER inválido: ${provider}`);
  }

  private async sendEvolutionText(numero: string, text: string): Promise<void> {
    const baseUrl = requireConfig(config.whatsapp.apiBaseUrl, "WHATSAPP_API_BASE_URL").replace(/\/$/, "");
    const instance = requireConfig(config.whatsapp.instance, "WHATSAPP_INSTANCE");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");

    await postJson(
      `${baseUrl}/message/sendText/${instance}`,
      { number: numero, text },
      { apikey: token }
    );
  }

  private async sendEvolutionImage(numero: string, imageBase64: string, caption: string): Promise<void> {
    const baseUrl = requireConfig(config.whatsapp.apiBaseUrl, "WHATSAPP_API_BASE_URL").replace(/\/$/, "");
    const instance = requireConfig(config.whatsapp.instance, "WHATSAPP_INSTANCE");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");

    await postJson(
      `${baseUrl}/message/sendMedia/${instance}`,
      {
        number: numero,
        mediatype: "image",
        mimetype: "image/png",
        caption,
        media: imageBase64,
        fileName: "comprovante-bilhete.png"
      },
      { apikey: token }
    );
  }

  private async sendZapiText(numero: string, text: string): Promise<void> {
    const baseUrl = requireConfig(config.whatsapp.apiBaseUrl, "WHATSAPP_API_BASE_URL").replace(/\/$/, "");
    const instance = requireConfig(config.whatsapp.instance, "WHATSAPP_INSTANCE");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");
    const clientToken = config.whatsapp.clientToken;

    await postJson(
      `${baseUrl}/instances/${instance}/token/${token}/send-text`,
      { phone: numero, message: text },
      clientToken ? { "Client-Token": clientToken } : {}
    );
  }

  private async sendZapiImage(numero: string, imageBase64: string, caption: string): Promise<void> {
    const baseUrl = requireConfig(config.whatsapp.apiBaseUrl, "WHATSAPP_API_BASE_URL").replace(/\/$/, "");
    const instance = requireConfig(config.whatsapp.instance, "WHATSAPP_INSTANCE");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");
    const clientToken = config.whatsapp.clientToken;

    await postJson(
      `${baseUrl}/instances/${instance}/token/${token}/send-image`,
      { phone: numero, image: imageBase64, caption },
      clientToken ? { "Client-Token": clientToken } : {}
    );
  }

  private async sendMetaText(numero: string, text: string): Promise<void> {
    const phoneNumberId = requireConfig(config.whatsapp.metaPhoneNumberId, "META_PHONE_NUMBER_ID");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");

    await postJson(
      `https://graph.facebook.com/${config.whatsapp.metaApiVersion}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "text",
        text: { body: text }
      },
      { Authorization: `Bearer ${token}` }
    );
  }

  private async sendMetaImage(numero: string, imageBase64: string, caption: string): Promise<void> {
    const phoneNumberId = requireConfig(config.whatsapp.metaPhoneNumberId, "META_PHONE_NUMBER_ID");
    const token = requireConfig(config.whatsapp.apiToken, "WHATSAPP_API_TOKEN");
    const buffer = Buffer.from(imageBase64, "base64");
    const formData = new FormData();

    formData.append("messaging_product", "whatsapp");
    formData.append("file", new Blob([buffer], { type: "image/png" }), "comprovante-bilhete.png");

    const uploadResponse = await fetch(
      `https://graph.facebook.com/${config.whatsapp.metaApiVersion}/${phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      }
    );

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => "");
      throw new Error(`Upload Meta retornou ${uploadResponse.status}: ${text.slice(0, 500)}`);
    }

    const upload = (await uploadResponse.json()) as { id?: string };

    if (!upload.id) {
      throw new Error("Upload Meta não retornou id de mídia");
    }

    await postJson(
      `https://graph.facebook.com/${config.whatsapp.metaApiVersion}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "image",
        image: {
          id: upload.id,
          caption
        }
      },
      { Authorization: `Bearer ${token}` }
    );
  }
}
