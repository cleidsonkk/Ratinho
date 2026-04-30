import { hasDatabase } from "../src/modules/persistence.js";

export default function handler(_req: any, res: any): void {
  res.status(200).json({
    ok: true,
    runtime: "vercel",
    database: hasDatabase(),
    timestamp: new Date().toISOString()
  });
}
