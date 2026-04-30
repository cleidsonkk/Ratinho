import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "../config.js";

let sqlClient: NeonQueryFunction<false, false> | null = null;

export type OperationalCleanupResult = {
  validationJobs: number;
  reservations: number;
  payments: number;
  creditAccounts: number;
  profiles: number;
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

function countRows(rows: unknown[]): number {
  return rows.length;
}

export async function deleteValidationJobById(jobId: string): Promise<boolean> {
  const rows = await getSql()`
    DELETE FROM validation_jobs
    WHERE id = ${jobId}
    RETURNING id
  `;

  return rows.length > 0;
}

export async function clearOperationalData(): Promise<OperationalCleanupResult> {
  const result = await getSql().transaction((tx) => [
    tx`
      DELETE FROM customer_credit_reservations
      RETURNING job_id
    `,
    tx`
      DELETE FROM customer_credit_payments
      RETURNING id
    `,
    tx`
      DELETE FROM customer_credit_accounts
      RETURNING channel, phone
    `,
    tx`
      DELETE FROM customer_profiles
      RETURNING channel, recipient_id
    `,
    tx`
      DELETE FROM validation_jobs
      RETURNING id
    `
  ]);

  return {
    reservations: countRows(result[0]),
    payments: countRows(result[1]),
    creditAccounts: countRows(result[2]),
    profiles: countRows(result[3]),
    validationJobs: countRows(result[4])
  };
}
