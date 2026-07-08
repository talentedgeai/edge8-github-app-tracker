import "./env.js";
import { db } from "./db.js";

// Quick capture inspector — works on both backends. Run: npm run inspect
console.log(`backend: ${db.kind}`);

const recent = await db.all(
  `SELECT event, action, received_at FROM webhook_deliveries ORDER BY received_at DESC LIMIT 10`,
);
console.log("\nLast 10 webhook deliveries:");
console.table(recent);

console.log("Row counts:");
for (const t of [
  "webhook_deliveries",
  "push_events",
  "pull_requests",
  "app_installations",
  "git_access_events",
  "engineer_keys",
  "work_spans",
  "capture_flags",
]) {
  const c = await db.get(`SELECT COUNT(*) AS c FROM ${t}`);
  console.log(`  ${t.padEnd(20)} ${c.c}`);
}

const inst = await db.all(
  `SELECT installation_id, account_login, account_type, repo_ids FROM app_installations`,
);
if (inst.length) {
  console.log("\nInstallations:");
  console.table(inst);
}

const access = await db.all(
  `SELECT kind, repo_path, verb, received_at FROM git_access_events ORDER BY id DESC LIMIT 10`,
);
if (access.length) {
  console.log("\nRecent access events (token / beacon):");
  console.table(access);
}

const spans = await db.all(
  `SELECT delivery_id, member, branch, span_start, span_end, tokens, rule,
          token_class, class_source, pull_request_id
   FROM work_spans ORDER BY id`,
);
if (spans.length) {
  console.log("\nWork spans (minted):");
  console.table(spans);
}

const cflags = await db.all(
  `SELECT kind, repo_id, ref, raised_at FROM capture_flags ORDER BY id`,
);
if (cflags.length) {
  console.log("\nCapture flags:");
  console.table(cflags);
}
process.exit(0);
