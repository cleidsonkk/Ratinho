import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

type EnvMap = Map<string, string>;

type SiteLoginModel = {
  ID?: number;
  IP?: string;
  AUTHTOKEN?: string;
  LOGIN?: string;
  NIVEL?: number;
  DTOKEN?: string;
  RTOKEN?: string;
};

function resolveCaptureUrl(): string {
  const configuredUrl = process.env.TARGET_URL?.trim();

  if (!configuredUrl) {
    return "https://www.esportese.bet/";
  }

  try {
    const parsed = new URL(configuredUrl);
    return `${parsed.origin}/`;
  } catch {
    return "https://www.esportese.bet/";
  }
}

async function readEnv(path: string): Promise<EnvMap> {
  const env = new Map<string, string>();

  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([^#][^=]+)=(.*)$/);
      if (match) {
        env.set(match[1], match[2]);
      }
    }
  } catch {
    // File does not exist yet.
  }

  return env;
}

async function writeEnv(path: string, env: EnvMap): Promise<void> {
  const lines = Array.from(env.entries()).map(([key, value]) => `${key}=${value}`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

function parseLoginModel(value: string): SiteLoginModel | null {
  const candidates = [value, decodeURIComponent(value)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as SiteLoginModel;
      if (parsed?.ID && parsed.ID > 0) {
        return parsed;
      }
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const captureUrl = resolveCaptureUrl();

  await page.goto(captureUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });

  console.log("Janela aberta. Faca login no site e aguarde este script detectar a sessao.");
  console.log("Quando o login funcionar, os campos TARGET_* serao salvos em .env.local.");

  let login: SiteLoginModel | null = null;
  let sessionId = "";

  for (let attempt = 0; attempt < 180; attempt += 1) {
    const cookies = await context.cookies("https://www.esportese.bet");
    const loginCookie = cookies.find((cookie) => cookie.name === "usercookie42")
      ?? cookies.find((cookie) => cookie.name === "usercookie52");
    const sessionCookie = cookies.find((cookie) => cookie.name === "ASP.NET.SessionId");

    if (loginCookie) {
      login = parseLoginModel(loginCookie.value);
    }

    if (sessionCookie?.value) {
      sessionId = sessionCookie.value;
    }

    if (login?.ID && login.AUTHTOKEN) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (!login?.ID || !login.AUTHTOKEN) {
    await browser.close();
    throw new Error("Nao detectei login valido. Tente novamente e confirme se o site entrou de fato.");
  }

  const envPath = ".env.local";
  const env = await readEnv(envPath);

  env.set("TARGET_AUTH_TOKEN", login.AUTHTOKEN);
  env.set("TARGET_USER_ID", String(login.ID));
  env.set("TARGET_RTOKEN", login.RTOKEN || sessionId);
  env.set("TARGET_DTOKEN", login.DTOKEN ?? "");
  env.set("TARGET_IP", login.IP ?? "");

  await writeEnv(envPath, env);
  await browser.close();

  console.log(`Sessao capturada para usuario ${login.LOGIN ?? login.ID}.`);
  console.log("Atualize essas variaveis tambem na Vercel antes de confirmar bilhetes em producao.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
