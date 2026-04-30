import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";
import { log } from "../logger.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

export type AdminNotificationTarget = {
  channel: "telegram" | "whatsapp";
  targetId: string;
  displayName: string | null;
  username: string | null;
  source: "env" | "database";
};

function getSql(): NeonQueryFunction<false, false> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  if (!sqlClient) {
    sqlClient = neon(config.databaseUrl);
  }

  return sqlClient;
}

function preferredChannel(): "telegram" | "whatsapp" {
  return config.adminNotifications.channel === "whatsapp" ? "whatsapp" : "telegram";
}

function normalizeTargetId(channel: "telegram" | "whatsapp", targetId: string): string {
  if (channel !== "whatsapp") {
    return targetId.trim();
  }

  const digits = targetId.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  // Meta WhatsApp expects the country code. When the admin provides only the
  // Brazilian local mobile number, prefix it with 55 automatically.
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }

  return digits;
}

function envTargets(): AdminNotificationTarget[] {
  if (preferredChannel() === "whatsapp") {
    return config.adminNotifications.whatsappNumbers.map((targetId) => ({
      channel: "whatsapp",
      targetId: normalizeTargetId("whatsapp", targetId),
      displayName: "Configurado no ambiente",
      username: null,
      source: "env"
    }));
  }

  return config.adminNotifications.telegramChatIds.map((targetId) => ({
    channel: "telegram",
    targetId,
    displayName: "Configurado no ambiente",
    username: null,
    source: "env"
  }));
}

function uniqueTargets(targets: AdminNotificationTarget[]): AdminNotificationTarget[] {
  const seen = new Set<string>();
  const unique: AdminNotificationTarget[] = [];

  for (const target of targets) {
    const key = `${target.channel}:${target.targetId}`;

    if (!target.targetId || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(target);
  }

  return unique;
}

export async function syncConfiguredAdminTelegramTargets(): Promise<number> {
  const targets = envTargets();

  if (!config.databaseUrl || targets.length === 0 || preferredChannel() !== "telegram") {
    return 0;
  }

  try {
    await getSql().transaction((tx) => targets.map((target) => tx`
      INSERT INTO admin_notification_targets (
        channel,
        target_id,
        display_name,
        username,
        enabled
      )
      VALUES (
        'telegram',
        ${target.targetId},
        ${target.displayName},
        ${target.username},
        true
      )
      ON CONFLICT (channel, target_id) DO UPDATE SET
        display_name = COALESCE(admin_notification_targets.display_name, EXCLUDED.display_name),
        username = COALESCE(admin_notification_targets.username, EXCLUDED.username),
        enabled = true,
        updated_at = now()
    `));
  } catch (error) {
    log("warn", "Falha ao sincronizar destinos administrativos configurados no ambiente", {
      error: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }

  return uniqueTargets(targets).length;
}

export async function loadAdminTelegramTargets(): Promise<AdminNotificationTarget[]> {
  const targets = envTargets();

  if (!config.databaseUrl || preferredChannel() !== "telegram") {
    return uniqueTargets(targets);
  }

  try {
    const rows = await getSql()`
      SELECT target_id, display_name, username
      FROM admin_notification_targets
      WHERE channel = 'telegram'
        AND enabled = true
      ORDER BY updated_at DESC
    `;

    for (const row of rows as Array<Record<string, any>>) {
      targets.push({
        channel: "telegram",
        targetId: String(row.target_id ?? ""),
        displayName: typeof row.display_name === "string" ? row.display_name : null,
        username: typeof row.username === "string" ? row.username : null,
        source: "database"
      });
    }
  } catch (error) {
    log("warn", "Falha ao carregar destinos administrativos do Telegram", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return uniqueTargets(targets);
}

export async function countAdminTelegramTargets(): Promise<number> {
  return (await loadAdminTelegramTargets()).length;
}

export async function countAdminNotificationTargets(): Promise<number> {
  return (await loadAdminTelegramTargets()).length;
}

export async function upsertAdminNotificationTarget(input: {
  channel: "telegram" | "whatsapp";
  targetId: string;
  displayName: string | null;
  username: string | null;
}): Promise<void> {
  const normalizedTargetId = normalizeTargetId(input.channel, input.targetId);

  await getSql()`
    INSERT INTO admin_notification_targets (
      channel,
      target_id,
      display_name,
      username,
      enabled
    )
    VALUES (
      ${input.channel},
      ${normalizedTargetId},
      ${input.displayName},
      ${input.username},
      true
    )
    ON CONFLICT (channel, target_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, admin_notification_targets.display_name),
      username = COALESCE(EXCLUDED.username, admin_notification_targets.username),
      enabled = true,
      updated_at = now()
  `;
}

export async function upsertAdminTelegramTarget(input: {
  targetId: string;
  displayName: string | null;
  username: string | null;
}): Promise<void> {
  await upsertAdminNotificationTarget({
    channel: "telegram",
    targetId: input.targetId,
    displayName: input.displayName,
    username: input.username
  });
}

export async function markAdminTelegramTargetNotified(targetId: string): Promise<void> {
  await markAdminNotificationTargetNotified("telegram", targetId);
}

export async function markAdminNotificationTargetNotified(
  channel: "telegram" | "whatsapp",
  targetId: string
): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  try {
    await getSql()`
      UPDATE admin_notification_targets
      SET last_notified_at = now(), updated_at = now()
      WHERE channel = ${channel}
        AND target_id = ${targetId}
    `;
  } catch (error) {
    log("warn", "Falha ao atualizar ultimo envio administrativo", {
      targetId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
