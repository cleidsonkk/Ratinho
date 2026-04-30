import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const logDir = path.resolve("data", "logs");
const logPath = path.join(logDir, "validations.jsonl");

export async function appendAuditLog(entry: Record<string, unknown>): Promise<void> {
  if (process.env.VERCEL) {
    return;
  }

  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
