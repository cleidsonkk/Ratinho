import { waitUntil } from "@vercel/functions";
import { authorizeRequest } from "../src/modules/security.js";
import { prepareInboundForProcessing } from "../src/modules/inboundHandler.js";
import { processValidationJob } from "../src/modules/processor.js";

export default async function handler(req: any, res: any): Promise<void> {
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
    waitUntil(processValidationJob(result.job));
  }

  res.status(202).json({
    ok: true,
    queued: true,
    duplicate: result.duplicate,
    jobId: result.job.id,
    codigo: result.job.codigo
  });
}
