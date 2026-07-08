import "./env.js";
import crypto from "node:crypto";
import { db } from "./db.js";

// Seed one test engineer key (brief §8). The FULL secret is what you send in the
// x-edge8-key header; we persist only its sha256 hash, never the secret itself.
const FULL = process.env.SEED_KEY ?? "e8k_test0001_supersecretstring";
const keyId = FULL.split("_").slice(0, 2).join("_"); // "e8k_test0001"
const keyHash = crypto.createHash("sha256").update(FULL).digest("hex");

await db.run(
  `INSERT INTO engineer_keys (key_id, key_hash, member, status)
   VALUES (?,?,?,?) ON CONFLICT (key_id) DO NOTHING`,
  keyId,
  keyHash,
  "dev@local",
  "active",
);

console.log(
  `[seed] engineer key ready: key_id=${keyId} — send the FULL secret in the x-edge8-key header`,
);
