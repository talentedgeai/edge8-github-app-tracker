import { handleAdminKeys } from "../../src/handlers.js";

// Admin key management over HTTP. Gated by the x-admin-token header (ADMIN_TOKEN).
//   POST   {email}   -> create a key (returned once)
//   GET              -> list keys (no secrets)
//   DELETE {key_id}  -> revoke
export default async function handler(req: any, res: any) {
  const params = { ...(req.query ?? {}), ...(req.body ?? {}) };
  const r = await handleAdminKeys(
    String(req.headers["x-admin-token"] ?? ""),
    req.method ?? "GET",
    params,
  );
  res.status(r.status).json(r.json ?? {});
}
