import { handleBeacon } from "../src/handlers.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).end();
  const r = await handleBeacon(
    String(req.headers["x-edge8-key"] ?? ""),
    req.body ?? {},
  );
  res.status(r.status).end();
}
