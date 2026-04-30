import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "sim"].includes(value.toLowerCase());
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatFromEnv(value: string | undefined, fallback: number): number {
  const normalized = (value ?? "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: intFromEnv(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  targetUrl: process.env.TARGET_URL ?? "https://www.esportese.bet/bilhete3.aspx",
  headless: boolFromEnv(process.env.HEADLESS, true),
  browserTimeoutMs: intFromEnv(process.env.BROWSER_TIMEOUT_MS, 10_000),
  confirmPreTicket: boolFromEnv(process.env.CONFIRM_PRE_TICKET, true),
  playwrightUserDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR ?? (process.env.VERCEL ? "/tmp/playwright-profile" : ".playwright-profile"),
  playwrightWsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT ?? "",
  playwrightConnectMode: (process.env.PLAYWRIGHT_CONNECT_MODE ?? "cdp").toLowerCase(),
  storageStatePath: process.env.STORAGE_STATE_PATH ?? "",
  storeScreenshotsLocal: boolFromEnv(process.env.STORE_SCREENSHOTS_LOCAL, false),
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  webhookAllowedIps: (process.env.WEBHOOK_ALLOWED_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean),
  maxMessageLength: intFromEnv(process.env.MAX_MESSAGE_LENGTH, 1_000),
  jobConcurrency: intFromEnv(process.env.JOB_CONCURRENCY, 1),
  customerDefaultCreditLimit: floatFromEnv(process.env.CUSTOMER_DEFAULT_CREDIT_LIMIT, 150),
  adminNotifications: {
    channel: (process.env.ADMIN_NOTIFICATION_CHANNEL ?? "telegram").toLowerCase(),
    telegramChatIds: listFromEnv(process.env.ADMIN_TELEGRAM_CHAT_IDS),
    whatsappNumbers: listFromEnv(process.env.ADMIN_WHATSAPP_NUMBERS),
    lowCreditPercent: floatFromEnv(process.env.ADMIN_LOW_CREDIT_PERCENT, 20)
  },
  whatsapp: {
    provider: (process.env.WHATSAPP_PROVIDER ?? "none").toLowerCase(),
    apiBaseUrl: process.env.WHATSAPP_API_BASE_URL ?? "",
    apiToken: process.env.WHATSAPP_API_TOKEN ?? "",
    instance: process.env.WHATSAPP_INSTANCE ?? "",
    clientToken: process.env.WHATSAPP_CLIENT_TOKEN ?? "",
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? process.env.WEBHOOK_SECRET ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
    metaApiVersion: process.env.META_API_VERSION ?? "v21.0"
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? ""
  },
  admin: {
    username: process.env.ADMIN_USERNAME ?? "",
    password: process.env.ADMIN_PASSWORD ?? ""
  },
  targetSite: {
    apiBaseUrl: process.env.TARGET_API_BASE_URL ?? "https://www.esportese.bet/futebolapi",
    authToken: process.env.TARGET_AUTH_TOKEN ?? "",
    userId: process.env.TARGET_USER_ID ?? "0",
    rToken: process.env.TARGET_RTOKEN ?? "",
    dToken: process.env.TARGET_DTOKEN ?? "",
    ip: process.env.TARGET_IP ?? ""
  }
} as const;
