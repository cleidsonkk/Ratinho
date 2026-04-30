import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config as appConfig } from "../../src/config.js";
import { log } from "../../src/logger.js";
import { prepareInboundForProcessing } from "../../src/modules/inboundHandler.js";
import { processValidationJob } from "../../src/modules/processor.js";
import { authorizeRequest } from "../../src/modules/security.js";
import { parseInboundWhatsAppMessage } from "../../src/modules/webhookParser.js";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req: any): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }

  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function safeCompareHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!appConfig.whatsapp.appSecret) {
    log("warn", "META_APP_SECRET nao configurado; assinatura Meta nao validada");
    return true;
  }

  const received = signatureHeader?.trim() ?? "";
  const prefix = "sha256=";

  if (!received.startsWith(prefix)) {
    return false;
  }

  const receivedHash = received.slice(prefix.length);
  const expectedHash = createHmac("sha256", appConfig.whatsapp.appSecret)
    .update(rawBody)
    .digest("hex");

  return safeCompareHex(receivedHash, expectedHash);
}

function whatsappPayloadSummary(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return { bodyType: typeof body };
  }

  const payload = body as Record<string, any>;
  const firstChange = payload.entry?.[0]?.changes?.[0];
  const value = firstChange?.value;
  const firstMessage = value?.messages?.[0];
  const firstStatus = value?.statuses?.[0];

  return {
    object: payload.object,
    field: firstChange?.field,
    hasMessages: Array.isArray(value?.messages),
    messageType: firstMessage?.type,
    hasTextBody: typeof firstMessage?.text?.body === "string",
    hasStatuses: Array.isArray(value?.statuses),
    statusType: firstStatus?.status
  };
}

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method === "GET") {
    const mode = String(req.query?.["hub.mode"] ?? "");
    const token = String(req.query?.["hub.verify_token"] ?? "");
    const challenge = String(req.query?.["hub.challenge"] ?? "");

    if (mode === "subscribe" && appConfig.whatsapp.webhookVerifyToken && token === appConfig.whatsapp.webhookVerifyToken) {
      res.status(200).send(challenge);
      return;
    }

    res.status(403).json({ ok: false, error: "verification_failed" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const authorized = await authorizeRequest({
    ip: String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] ?? ""),
    getHeader: (name) => req.headers[name.toLowerCase()] as string | undefined
  });

  if (!authorized) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const rawBody = await readRawBody(req);

  if (!verifyMetaSignature(rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
    log("warn", "Webhook WhatsApp bloqueado por assinatura Meta invalida", {
      hasSignature: Boolean(req.headers["x-hub-signature-256"])
    });
    res.status(401).json({ ok: false, error: "invalid_meta_signature" });
    return;
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  const inbound = parseInboundWhatsAppMessage(body);

  if (!inbound) {
    log("info", "Webhook WhatsApp ignorado sem mensagem de texto ou numero", {
      summary: whatsappPayloadSummary(body)
    });
    res.status(202).json({ ok: true, ignored: true, reason: "mensagem_sem_texto_ou_numero" });
    return;
  }

  log("info", "Webhook WhatsApp recebido", {
    recipientId: inbound.recipientId,
    externalMessageId: inbound.externalMessageId,
    messageLength: inbound.mensagem.length,
    summary: whatsappPayloadSummary(body)
  });

  const result = await prepareInboundForProcessing(inbound);

  if (result.kind !== "queued") {
    log("info", "Webhook WhatsApp nao enfileirado", {
      recipientId: inbound.recipientId,
      externalMessageId: inbound.externalMessageId,
      reason: result.kind,
      detail: "reason" in result ? result.reason : undefined
    });
    res.status(202).json({ ok: true, queued: false, reason: result.kind });
    return;
  }

  if (!result.duplicate) {
    waitUntil(processValidationJob(result.job).catch((error) => {
      log("error", "Falha no processamento assíncrono do WhatsApp", {
        jobId: result.job.id,
        codigo: result.job.codigo,
        recipientId: result.job.recipientId,
        error: error instanceof Error ? error.message : String(error)
      });
    }));
  }

  log("info", "Webhook WhatsApp enfileirado", {
    jobId: result.job.id,
    duplicate: result.duplicate,
    recipientId: result.job.recipientId,
    codigo: result.job.codigo
  });

  res.status(202).json({
    ok: true,
    queued: true,
    duplicate: result.duplicate,
    jobId: result.job.id,
    codigo: result.job.codigo
  });
}
