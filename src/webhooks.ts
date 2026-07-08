// The webhook flow moved to src/handlers.ts (shared by the local Express server and
// the Vercel functions). This re-export keeps older imports working.
export { handleWebhook } from "./handlers.js";
