import "../src/env.js";
import crypto from "node:crypto";
import { db } from "../src/db.js";

// Admin: issue an engineer key. Runs against whichever backend the env selects
// (TRACKER_DB_URL -> Supabase, else local SQLite).
//   npm run issue-key -- --email someone@edge8.ai
const args = process.argv.slice(2);
const emailIdx = args.indexOf("--email");
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
if (!email || !email.includes("@")) {
  console.error("usage: npm run issue-key -- --email someone@company.com");
  process.exit(1);
}

const keyId = `e8k_${crypto.randomBytes(4).toString("hex")}`;
const secret = crypto.randomBytes(24).toString("hex");
const full = `${keyId}_${secret}`;
const hash = crypto.createHash("sha256").update(full).digest("hex");

await db.run(
  `INSERT INTO engineer_keys (key_id, key_hash, member, status) VALUES (?,?,?,'active')`,
  keyId,
  hash,
  email,
);

console.log(`\nEngineer key issued for ${email} (backend: ${db.kind})`);
console.log(`  key_id: ${keyId}`);
console.log(`\nSend this FULL key to the engineer — it is shown ONCE and never stored:\n`);
console.log(`  ${full}\n`);
console.log(`They run:  tracker setup --key ${full} --server <server-url>`);
process.exit(0);
