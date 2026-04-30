import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";
import type { InboundMessage } from "../types.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

export type CustomerProfile = {
  channel: string;
  recipientId: string;
  displayName: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
};

type TelegramContactResult =
  | { stored: true; phoneNumber: string }
  | { stored: false; reason: "no_contact" | "contact_from_other_user" };

function getSql(): NeonQueryFunction<false, false> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  if (!sqlClient) {
    sqlClient = neon(config.databaseUrl);
  }

  return sqlClient;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function telegramMessage(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const update = raw as Record<string, any>;
  const message = update.message ?? update.edited_message ?? update.channel_post;
  return message && typeof message === "object" ? message : {};
}

function displayName(firstName: string | null, lastName: string | null, fallback: string | null): string | null {
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return joined || fallback;
}

function normalizePhoneNumber(phoneNumber: unknown): string | null {
  if (typeof phoneNumber !== "string" && typeof phoneNumber !== "number") {
    return null;
  }

  const value = String(phoneNumber).trim();
  return value || null;
}

export function formatPhoneNumber(phoneNumber: string | null): string | null {
  if (!phoneNumber) {
    return null;
  }

  const digits = phoneNumber.replace(/\D/g, "");

  if (digits.length === 13 && digits.startsWith("55")) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }

  if (digits.length === 11) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7)}`;
  }

  if (digits.length === 10) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return phoneNumber;
}

export function isTelegramContactMessage(inbound: InboundMessage): boolean {
  return inbound.channel === "telegram" && Boolean(telegramMessage(inbound.raw).contact);
}

export function customerIdentityFromInbound(inbound: InboundMessage): Omit<CustomerProfile, "phoneNumber"> {
  if (inbound.channel === "telegram") {
    const message = telegramMessage(inbound.raw);
    const user = message.from ?? message.chat ?? {};
    const firstName = pickString(user.first_name);
    const lastName = pickString(user.last_name);

    return {
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      firstName,
      lastName,
      username: pickString(user.username),
      displayName: displayName(firstName, lastName, null)
    };
  }

  const raw = inbound.raw as Record<string, any> | null;
  const name = pickString(
    raw?.pushName,
    raw?.senderName,
    raw?.name,
    raw?.data?.pushName,
    raw?.data?.senderName,
    raw?.data?.name,
    raw?.data?.key?.pushName
  );

  return {
    channel: inbound.channel,
    recipientId: inbound.recipientId,
    firstName: name,
    lastName: null,
    username: null,
    displayName: name
  };
}

export async function upsertCustomerProfileFromInbound(inbound: InboundMessage): Promise<void> {
  if (!config.databaseUrl) {
    return;
  }

  const identity = customerIdentityFromInbound(inbound);

  await getSql()`
    INSERT INTO customer_profiles (
      channel,
      recipient_id,
      display_name,
      username,
      first_name,
      last_name
    )
    VALUES (
      ${identity.channel},
      ${identity.recipientId},
      ${identity.displayName},
      ${identity.username},
      ${identity.firstName},
      ${identity.lastName}
    )
    ON CONFLICT (channel, recipient_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, customer_profiles.display_name),
      username = COALESCE(EXCLUDED.username, customer_profiles.username),
      first_name = COALESCE(EXCLUDED.first_name, customer_profiles.first_name),
      last_name = COALESCE(EXCLUDED.last_name, customer_profiles.last_name),
      updated_at = now()
  `;
}

export async function upsertTelegramContact(inbound: InboundMessage): Promise<TelegramContactResult> {
  if (!config.databaseUrl) {
    return { stored: false, reason: "no_contact" };
  }

  const message = telegramMessage(inbound.raw);
  const contact = message.contact;

  if (!contact || typeof contact !== "object") {
    return { stored: false, reason: "no_contact" };
  }

  const senderId = pickString(message.from?.id);
  const contactUserId = pickString(contact.user_id);

  if (senderId && contactUserId && senderId !== contactUserId) {
    return { stored: false, reason: "contact_from_other_user" };
  }

  const identity = customerIdentityFromInbound(inbound);
  const phoneNumber = normalizePhoneNumber(contact.phone_number);
  const contactFirstName = pickString(contact.first_name);
  const contactLastName = pickString(contact.last_name);

  if (!phoneNumber) {
    return { stored: false, reason: "no_contact" };
  }

  await getSql()`
    INSERT INTO customer_profiles (
      channel,
      recipient_id,
      display_name,
      username,
      first_name,
      last_name,
      phone_number,
      raw_contact,
      contact_shared_at
    )
    VALUES (
      ${identity.channel},
      ${identity.recipientId},
      ${displayName(contactFirstName, contactLastName, identity.displayName)},
      ${identity.username},
      ${contactFirstName ?? identity.firstName},
      ${contactLastName ?? identity.lastName},
      ${phoneNumber},
      ${JSON.stringify(contact)}::jsonb,
      now()
    )
    ON CONFLICT (channel, recipient_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, customer_profiles.display_name),
      username = COALESCE(EXCLUDED.username, customer_profiles.username),
      first_name = COALESCE(EXCLUDED.first_name, customer_profiles.first_name),
      last_name = COALESCE(EXCLUDED.last_name, customer_profiles.last_name),
      phone_number = EXCLUDED.phone_number,
      raw_contact = EXCLUDED.raw_contact,
      contact_shared_at = now(),
      updated_at = now()
  `;

  return { stored: true, phoneNumber };
}

export async function getCustomerProfile(channel: string, recipientId: string): Promise<CustomerProfile | null> {
  if (!config.databaseUrl) {
    return null;
  }

  const rows = await getSql().query(`
    SELECT channel, recipient_id, display_name, username, first_name, last_name, phone_number
    FROM customer_profiles
    WHERE channel = $1
      AND recipient_id = $2
    LIMIT 1
  `, [channel, recipientId]);

  const row = rows[0] as Record<string, any> | undefined;

  if (!row) {
    return null;
  }

  return {
    channel: row.channel,
    recipientId: row.recipient_id,
    displayName: pickString(row.display_name),
    username: pickString(row.username),
    firstName: pickString(row.first_name),
    lastName: pickString(row.last_name),
    phoneNumber: pickString(row.phone_number)
  };
}

export async function loadCustomerProfiles(keys: Array<{ channel: string; recipientId: string }>): Promise<Map<string, CustomerProfile>> {
  const profiles = new Map<string, CustomerProfile>();

  if (!config.databaseUrl || keys.length === 0) {
    return profiles;
  }

  const channels = keys.map((key) => key.channel);
  const recipientIds = keys.map((key) => key.recipientId);
  const rows = await getSql().query(`
    WITH keys AS (
      SELECT *
      FROM unnest($1::text[], $2::text[]) AS k(channel, recipient_id)
    )
    SELECT p.channel, p.recipient_id, p.display_name, p.username, p.first_name, p.last_name, p.phone_number
    FROM customer_profiles p
    JOIN keys k ON k.channel = p.channel AND k.recipient_id = p.recipient_id
  `, [channels, recipientIds]);

  for (const row of rows as Record<string, any>[]) {
    const profile = {
      channel: row.channel,
      recipientId: row.recipient_id,
      displayName: pickString(row.display_name),
      username: pickString(row.username),
      firstName: pickString(row.first_name),
      lastName: pickString(row.last_name),
      phoneNumber: pickString(row.phone_number)
    };

    profiles.set(`${profile.channel}:${profile.recipientId}`, profile);
  }

  return profiles;
}
