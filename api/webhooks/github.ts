import { handleWebhook } from "../../src/handlers.js";

// Vercel auto-parses JSON bodies, which would change the bytes GitHub signed —
// disable it and read the raw stream ourselves (HMAC needs the exact bytes).
export const config = { api: { bodyParser: false } };

async function readRaw(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const raw = await readRaw(req);
  const r = await handleWebhook({
    id: String(req.headers["x-github-delivery"] ?? ""),
    evt: String(req.headers["x-github-event"] ?? ""),
    sig: String(req.headers["x-hub-signature-256"] ?? ""),
    raw,
    headers: req.headers,
  });
  res.status(r.status).send(r.text ?? "");
}
