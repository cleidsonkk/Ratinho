import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";
import type { InboundMessage } from "../types.js";
import { getCustomerProfile } from "./customerProfile.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

export type AuthorizedPhoneRecord = {
  phone: string;
  name: string | null;
  blocked: boolean;
  createdAt: string;
  updatedAt: string;
};

export type InboundPhoneAuthorization =
  | { allowed: true; lookupPhone: string; matchedPhone: string }
  | { allowed: false; reason: "not_registered" | "blocked"; lookupPhone: string | null; matchedPhone: string | null };

function getSql(): NeonQueryFunction<false, false> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  if (!sqlClient) {
    sqlClient = neon(config.databaseUrl);
  }

  return sqlClient;
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizePhoneDigits(phone: unknown): string | null {
  if (typeof phone !== "string" && typeof phone !== "number") {
    return null;
  }

  const digits = String(phone).replace(/\D/g, "");
  return digits || null;
}

export function canonicalizeAuthorizedPhone(phone: unknown): string | null {
  const digits = normalizePhoneDigits(phone);

  if (!digits) {
    return null;
  }

  if (digits.startsWith("55")) {
    const national = digits.slice(2);

    if (national.length === 10) {
      return `55${national.slice(0, 2)}9${national.slice(2)}`;
    }

    if (national.length === 11) {
      return digits;
    }
  }

  if (digits.length === 10) {
    return `55${digits.slice(0, 2)}9${digits.slice(2)}`;
  }

  if (digits.length === 11) {
    return `55${digits}`;
  }

  if (digits.length >= 12 && digits.length <= 13) {
    return digits;
  }

  return null;
}

export function buildAuthorizedPhoneVariants(phone: unknown): string[] {
  const variants = new Set<string>();
  const normalized = normalizePhoneDigits(phone);
  const canonical = canonicalizeAuthorizedPhone(phone);

  if (normalized) {
    variants.add(normalized);
  }

  if (canonical) {
    variants.add(canonical);

    if (canonical.startsWith("55")) {
      const national = canonical.slice(2);

      variants.add(national);

      if (national.length === 11 && national[2] === "9") {
        const withoutNinthDigit = `${national.slice(0, 2)}${national.slice(3)}`;
        variants.add(withoutNinthDigit);
        variants.add(`55${withoutNinthDigit}`);
      }
    }
  }

  return [...variants];
}

async function findAuthorizedPhoneRecord(phone: unknown): Promise<AuthorizedPhoneRecord | null> {
  const variants = buildAuthorizedPhoneVariants(phone);

  if (variants.length === 0 || !config.databaseUrl) {
    return null;
  }

  const rows = await getSql().query(`
    SELECT phone, name, blocked, created_at, updated_at
    FROM authorized_phone_ids
    WHERE phone = ANY($1::text[])
    ORDER BY blocked DESC, updated_at DESC
    LIMIT 1
  `, [variants]);

  const row = rows[0] as Record<string, any> | undefined;

  if (!row) {
    return null;
  }

  return {
    phone: row.phone,
    name: pickString(row.name),
    blocked: Boolean(row.blocked),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

async function resolveInboundPhone(inbound: InboundMessage): Promise<string | null> {
  if (inbound.channel === "whatsapp") {
    return canonicalizeAuthorizedPhone(inbound.recipientId);
  }

  if (inbound.contactPhone) {
    return canonicalizeAuthorizedPhone(inbound.contactPhone);
  }

  const profile = await getCustomerProfile(inbound.channel, inbound.recipientId);
  return canonicalizeAuthorizedPhone(profile?.phoneNumber ?? null);
}

export async function authorizeInboundPhone(inbound: InboundMessage): Promise<InboundPhoneAuthorization> {
  if (!config.databaseUrl) {
    return {
      allowed: true,
      lookupPhone: canonicalizeAuthorizedPhone(inbound.recipientId) ?? inbound.recipientId,
      matchedPhone: canonicalizeAuthorizedPhone(inbound.recipientId) ?? inbound.recipientId
    };
  }

  const lookupPhone = await resolveInboundPhone(inbound);

  if (!lookupPhone) {
    return {
      allowed: false,
      reason: "not_registered",
      lookupPhone: null,
      matchedPhone: null
    };
  }

  const record = await findAuthorizedPhoneRecord(lookupPhone);

  if (!record) {
    return {
      allowed: false,
      reason: "not_registered",
      lookupPhone,
      matchedPhone: null
    };
  }

  if (record.blocked) {
    return {
      allowed: false,
      reason: "blocked",
      lookupPhone,
      matchedPhone: record.phone
    };
  }

  return {
    allowed: true,
    lookupPhone,
    matchedPhone: record.phone
  };
}

export async function listAuthorizedPhones(): Promise<AuthorizedPhoneRecord[]> {
  if (!config.databaseUrl) {
    return [];
  }

  const rows = await getSql().query(`
    SELECT phone, name, blocked, created_at, updated_at
    FROM authorized_phone_ids
    ORDER BY blocked ASC, updated_at DESC, phone ASC
  `);

  return (rows as Record<string, any>[]).map((row) => ({
    phone: row.phone,
    name: pickString(row.name),
    blocked: Boolean(row.blocked),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }));
}

export async function upsertAuthorizedPhone(input: { phone: string; name: string | null }): Promise<{ created: boolean; record: AuthorizedPhoneRecord }> {
  const canonicalPhone = canonicalizeAuthorizedPhone(input.phone);

  if (!canonicalPhone) {
    throw new Error("Celular invalido.");
  }

  const normalizedName = pickString(input.name);
  const existing = await findAuthorizedPhoneRecord(canonicalPhone);

  if (existing) {
    const rows = await getSql()`
      UPDATE authorized_phone_ids
      SET
        phone = ${canonicalPhone},
        name = COALESCE(${normalizedName}, authorized_phone_ids.name),
        updated_at = now()
      WHERE phone = ${existing.phone}
      RETURNING phone, name, blocked, created_at, updated_at
    `;

    const row = rows[0] as Record<string, any>;
    return {
      created: false,
      record: {
        phone: row.phone,
        name: pickString(row.name),
        blocked: Boolean(row.blocked),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
      }
    };
  }

  const rows = await getSql()`
    INSERT INTO authorized_phone_ids (
      phone,
      name,
      blocked
    )
    VALUES (
      ${canonicalPhone},
      ${normalizedName},
      false
    )
    RETURNING phone, name, blocked, created_at, updated_at
  `;

  const row = rows[0] as Record<string, any>;
  return {
    created: true,
    record: {
      phone: row.phone,
      name: pickString(row.name),
      blocked: Boolean(row.blocked),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }
  };
}

export async function setAuthorizedPhoneBlockedState(phone: string, blocked: boolean): Promise<boolean> {
  const record = await findAuthorizedPhoneRecord(phone);

  if (!record) {
    return false;
  }

  const rows = await getSql()`
    UPDATE authorized_phone_ids
    SET
      blocked = ${blocked},
      updated_at = now()
    WHERE phone = ${record.phone}
    RETURNING phone
  `;

  return rows.length > 0;
}

export async function deleteAuthorizedPhone(phone: string): Promise<boolean> {
  const record = await findAuthorizedPhoneRecord(phone);

  if (!record) {
    return false;
  }

  const rows = await getSql()`
    DELETE FROM authorized_phone_ids
    WHERE phone = ${record.phone}
    RETURNING phone
  `;

  return rows.length > 0;
}
