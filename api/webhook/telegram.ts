import { waitUntil } from "@vercel/functions";
import { prepareInboundForProcessing } from "../../src/modules/inboundHandler.js";
import { processValidationJob } from "../../src/modules/processor.js";
import { authorizeTelegramRequest } from "../../src/modules/security.js";
import { parseInboundTelegramMessage } from "../../src/modules/telegramWebhookParser.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const authorized = await authorizeTelegramRequest({
    ip: String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] ?? ""),
    getHeader: (name) => req.headers[name.toLowerCase()] as string | undefined
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
