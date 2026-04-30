import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN nao configurado");
  }

  if (!baseUrl) {
    throw new Error("PUBLIC_BASE_URL nao configurado");
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/webhook/telegram`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret || undefined,
      allowed_updates: ["message", "edited_message"]
    })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    throw new Error(`Falha ao configurar webhook: ${JSON.stringify(payload)}`);
  }

  console.log(`Webhook Telegram configurado: ${webhookUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
