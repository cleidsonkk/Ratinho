import express from "express";
import { config } from "./config.js";
import { log } from "./logger.js";
import {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  isAdminRequestAuthorized,
  verifyAdminCredentials
} from "./modules/adminAuth.js";
import { prepareInboundForProcessing } from "./modules/inboundHandler.js";
import { JobQueue } from "./modules/jobQueue.js";
import { processValidationJob } from "./modules/processor.js";
import { authorizeRequest, authorizeTelegramRequest } from "./modules/security.js";
import { parseInboundTelegramMessage } from "./modules/telegramWebhookParser.js";
import { parseInboundWhatsAppMessage } from "./modules/webhookParser.js";

const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false }));

const queue = new JobQueue(processValidationJob);

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAdminLoginPage(error: string | null = null): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Validador de Bilhetes - Admin</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #102033;
      --muted: #5d6b7c;
      --line: rgba(255,255,255,.34);
      --panel: rgba(255,255,255,.94);
      --accent: #0f766e;
      --accent-dark: #115e59;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      max-width: 100%;
      min-height: 100%;
      overflow-x: hidden;
    }
    body {
      margin: 0;
      color: var(--ink);
      font: 15px/1.45 Arial, Helvetica, sans-serif;
      letter-spacing: 0;
      background:
        linear-gradient(115deg, rgba(10, 22, 34, .90), rgba(15, 118, 110, .78)),
        repeating-linear-gradient(90deg, rgba(255,255,255,.08) 0 1px, transparent 1px 96px),
        repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 1px, transparent 1px 96px),
        #152235;
    }
    main {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
    }
    .shell {
      width: min(1080px, 100%);
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr);
      gap: 28px;
      align-items: center;
      min-width: 0;
    }
    .shell > *, form, label, input, button, p, h1, h2, span, strong { min-width: 0; }
    p, h1, h2, span, strong, input, button { overflow-wrap: anywhere; }
    .hero {
      color: #ffffff;
      padding: 18px 0;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      background: rgba(255,255,255,.10);
    }
    h1 {
      max-width: 720px;
      margin: 18px 0 12px;
      font-size: 52px;
      line-height: 1;
      letter-spacing: 0;
    }
    .hero p {
      max-width: 640px;
      margin: 0;
      color: rgba(255,255,255,.86);
      font-size: 17px;
    }
    .signals {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr));
      gap: 10px;
      margin-top: 28px;
      max-width: 680px;
    }
    .signal {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.10);
      padding: 12px;
      min-height: 78px;
    }
    .signal strong { display: block; font-size: 20px; }
    .signal span { color: rgba(255,255,255,.78); font-size: 12px; }
    .card {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,.62);
      border-radius: 10px;
      box-shadow: 0 24px 60px rgba(0,0,0,.25);
      padding: 26px;
      backdrop-filter: blur(16px);
    }
    .card h2 { margin: 0 0 6px; font-size: 22px; }
    .card p { margin: 0 0 20px; color: var(--muted); }
    label { display: block; margin-bottom: 13px; }
    label span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    input, button {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      min-height: 44px;
      border-radius: 7px;
      border: 1px solid #c9d1dc;
      background: #ffffff;
      color: var(--ink);
      font: inherit;
      padding: 10px 12px;
    }
    button {
      border-color: var(--accent);
      background: var(--accent);
      color: #ffffff;
      cursor: pointer;
      font-weight: 800;
      margin-top: 4px;
    }
    button:hover { background: var(--accent-dark); }
    .error {
      color: var(--danger);
      background: #fde8e7;
      border: 1px solid #f5b9b4;
      border-radius: 7px;
      padding: 10px 12px;
      margin-bottom: 14px;
      font-weight: 700;
    }
    .foot {
      margin-top: 16px;
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 860px) {
      main { padding: 18px; place-items: stretch; }
      .shell { grid-template-columns: 1fr; align-content: center; min-height: calc(100vh - 36px); }
      .signals { grid-template-columns: 1fr; }
      .hero { padding: 0; }
      h1 { font-size: 34px; }
      .hero p { font-size: 15px; }
      .card { padding: 20px; }
    }
    @media (max-width: 420px) {
      main { padding: 12px; }
      .shell { min-height: calc(100vh - 24px); gap: 16px; }
      h1 { font-size: 29px; }
      .card { padding: 16px; }
      .signal { min-height: auto; }
    }
  </style>
</head>
<body>
  <main>
    <section class="shell">
      <div class="hero">
        <span class="eyebrow">Operação em tempo real</span>
        <h1>Controle completo dos bilhetes validados pelo bot.</h1>
        <p>Área administrativa para acompanhar clientes, valores, jogos, confirmações e entregas do Telegram em uma visão segura e atualizada.</p>
        <div class="signals">
          <div class="signal"><strong>Ao vivo</strong><span>Atualização automática do painel</span></div>
          <div class="signal"><strong>Seguro</strong><span>Acesso protegido por sessão</span></div>
          <div class="signal"><strong>Detalhado</strong><span>Cliente, bilhete, jogos e valores</span></div>
        </div>
      </div>
      <form class="card" method="post" action="/admin/login">
        <h2>Entrar no painel</h2>
        <p>Use o acesso administrativo para visualizar a operação.</p>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        <label>
          <span>Login</span>
          <input name="username" autocomplete="username" required autofocus>
        </label>
        <label>
          <span>Senha</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Entrar</button>
        <div class="foot">Validador de Bilhetes · acesso restrito</div>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function isSecureRequest(req: express.Request): boolean {
  return Boolean(process.env.VERCEL || req.secure || req.header("x-forwarded-proto") === "https");
}

async function authorizeExpressRequest(req: express.Request): Promise<boolean> {
  return await authorizeRequest({
    ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] ?? ""),
    getHeader: (name) => req.header(name)
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    queue: queue.stats()
  });
});

app.get("/", (req, res) => {
  if (isAdminRequestAuthorized(req.headers)) {
    res.redirect(302, "/api/admin");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderAdminLoginPage());
});

app.post("/admin/login", (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!verifyAdminCredentials(username, password)) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderAdminLoginPage("Login ou senha inválidos."));
    return;
  }

  res.setHeader("Set-Cookie", createAdminSessionCookie(username, isSecureRequest(req)));
  res.redirect(303, "/api/admin");
});

app.get("/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearAdminSessionCookie());
  res.redirect(302, "/");
});

app.get(["/favicon.ico", "/favicon.png"], (_req, res) => {
  res.status(204).send();
});

app.post("/webhook/whatsapp", async (req, res) => {
  if (!(await authorizeExpressRequest(req))) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const inbound = parseInboundWhatsAppMessage(req.body);

  if (!inbound) {
    res.status(202).json({ ok: true, ignored: true, reason: "mensagem_sem_texto_ou_numero" });
    return;
  }

  const result = await prepareInboundForProcessing(inbound);

  if (result.kind !== "queued") {
    res.status(202).json({ ok: true, queued: false, reason: result.kind });
    return;
  }

  if (!result.duplicate) {
    queue.enqueue(result.job);
  }

  res.status(202).json({
    ok: true,
    queued: true,
    duplicate: result.duplicate,
    jobId: result.job.id,
    codigo: result.job.codigo
  });
});

app.post("/webhook/telegram", async (req, res) => {
  const authorized = await authorizeTelegramRequest({
    ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] ?? ""),
    getHeader: (name) => req.header(name)
  });

  if (!authorized) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const inbound = parseInboundTelegramMessage(req.body);

  if (!inbound) {
    res.status(202).json({ ok: true, ignored: true, reason: "mensagem_sem_texto_ou_chat" });
    return;
  }

  const result = await prepareInboundForProcessing(inbound);

  if (result.kind !== "queued") {
    res.status(202).json({ ok: true, queued: false, reason: result.kind });
    return;
  }

  if (!result.duplicate) {
    queue.enqueue(result.job);
  }

  res.status(202).json({
    ok: true,
    queued: true,
    duplicate: result.duplicate,
    jobId: result.job.id,
    codigo: result.job.codigo
  });
});

app.post("/validate", async (req, res) => {
  if (!(await authorizeExpressRequest(req))) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const channel = req.body?.channel === "telegram" ? "telegram" : "whatsapp";
  const numero = typeof req.body?.numero === "string" ? req.body.numero.replace(/\D/g, "") : "";
  const chatId = typeof req.body?.chatId === "string" || typeof req.body?.chatId === "number"
    ? String(req.body.chatId)
    : "";
  const recipientId = channel === "telegram" ? chatId : numero;
  const mensagem = typeof req.body?.mensagem === "string" ? req.body.mensagem : "";

  if (!recipientId || !mensagem) {
    res.status(400).json({ ok: false, error: "destinatario e mensagem sao obrigatorios" });
    return;
  }

  const result = await prepareInboundForProcessing({
    channel,
    recipientId,
    mensagem,
    externalMessageId: typeof req.body?.messageId === "string" ? req.body.messageId : null,
    raw: req.body
  });

  if (result.kind !== "queued") {
    res.status(202).json({ ok: true, queued: false, reason: result.kind });
    return;
  }

  if (!result.duplicate) {
    queue.enqueue(result.job);
  }

  res.status(202).json({
    ok: true,
    queued: true,
    duplicate: result.duplicate,
    jobId: result.job.id,
    codigo: result.job.codigo
  });
});

app.listen(config.port, () => {
  log("info", "Servidor iniciado", {
    port: config.port,
    targetUrl: config.targetUrl,
    whatsappProvider: config.whatsapp.provider,
    telegramEnabled: Boolean(config.telegram.botToken),
    confirmPreTicket: config.confirmPreTicket
  });
});
