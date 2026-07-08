import "./env.js"; // MUST be first — loads .env before anything reads process.env
import express from "express";
import {
  handleAdminKeys,
  handleAppToken,
  handleBeacon,
  handleHealth,
  handleWebhook,
} from "./handlers.js";
import type { HandlerResult } from "./handlers.js";

// Local dev server. Production (Vercel) uses api/* functions — both delegate to
// the same handlers in src/handlers.ts, so behaviour is identical.

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

function send(res: express.Response, r: HandlerResult): void {
  if (r.json !== undefined) res.status(r.status).json(r.json);
  else if (r.text !== undefined) res.status(r.status).send(r.text);
  else res.status(r.status).end();
}

app.get("/health", async (_req, res) => send(res, await handleHealth()));

// RAW body on the webhook route — required for signature verification.
app.post(
  "/webhooks/github",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    send(
      res,
      await handleWebhook({
        id: req.header("x-github-delivery") ?? "",
        evt: req.header("x-github-event") ?? "",
        sig: req.header("x-hub-signature-256") ?? "",
        raw,
        headers: req.headers,
      }),
    );
  },
);

app.post("/app-token", express.json(), async (req, res) =>
  send(res, await handleAppToken(req.header("x-edge8-key") ?? "", req.body)),
);

app.post("/beacon", express.json(), async (req, res) =>
  send(res, await handleBeacon(req.header("x-edge8-key") ?? "", req.body)),
);

app.all("/admin/keys", express.json(), async (req, res) =>
  send(
    res,
    await handleAdminKeys(req.header("x-admin-token") ?? "", req.method, {
      ...req.query,
      ...req.body,
    }),
  ),
);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
