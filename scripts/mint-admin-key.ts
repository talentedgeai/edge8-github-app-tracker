import "../src/env.js";
import crypto from "node:crypto";
import { db } from "../src/db.js";

// Bootstrap: mint an ADMIN key — the credential for /api/admin/keys itself.
// Runs against whichever backend the env selects (TRACKER_DB_URL -> Supabase,
// else local SQLite).
//   npm run mint-admin-key -- --email someone@edge8.ai
//
// This exists because of a chicken-and-egg problem: the HTTP route that mints
// admin keys requires an admin key. On a database with an empty admin_keys
// table the only ways in are the legacy shared ADMIN_TOKEN or this script, and
// the point of the exercise is to stop depending on the former.
//
// Once every admin has a key, delete ADMIN_TOKEN from the Vercel environment.
// After that, further admin keys can be minted over HTTP:
//   curl -X POST ".../api/admin/keys?target=admin" \
//     -H "x-admin-token: <your e8a_ key>" -H "content-type: application/json" \
//     -d '{"email":"someone@edge8.ai"}'
const args = process.argv.slice(2);
const emailIdx = args.indexOf("--email");
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
if (!email || !email.includes("@")) {
  console.error("usage: npm run mint-admin-key -- --email someone@company.com");
  process.exit(1);
}

// e8a_ rather than e8k_: an admin key and an engineer key must never be
// mistaken for one another at a glance, in a terminal or in a log line.
const keyId = `e8a_${crypto.randomBytes(4).toString("hex")}`;
const secret = crypto.randomBytes(24).toString("hex");
const full = `${keyId}_${secret}`;
const hash = crypto.createHash("sha256").update(full).digest("hex");

await db.run(
  `INSERT INTO admin_keys (key_id, key_hash, member, status) VALUES (?,?,?,'active')`,
  keyId,
  hash,
  email,
);

console.log(`\nADMIN key issued for ${email} (backend: ${db.kind})`);
console.log(`  key_id: ${keyId}`);
console.log(`\nThis key can mint engineer keys for EVERY tracked repo in every covered`);
console.log(`org. Send it privately, never paste it into a chat tool or commit it.`);
console.log(`It is shown ONCE and never stored:\n`);
console.log(`  ${full}\n`);
console.log(`Use it as:  -H "x-admin-token: ${keyId}_..."`);
process.exit(0);
