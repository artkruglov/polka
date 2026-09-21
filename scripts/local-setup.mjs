import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const password = randomBytes(24).toString("hex");
const storage = randomBytes(24).toString("hex");
const env = `# Local development only. Never commit this file.\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgres://polka:${password}@127.0.0.1:54388/polka\nS3_ENDPOINT=http://127.0.0.1:9038\nS3_ACCESS_KEY=polka-local\nS3_SECRET_KEY=${storage}\nS3_BUCKET=polka-local\nLINK_KEY=${randomBytes(32).toString("hex")}\nAPP_ORIGIN=http://127.0.0.1:4390\nHOST=127.0.0.1\nPORT=4390\nCOOKIE_SECURE=false\n`;
try {
  await writeFile(".env", env, { flag: "wx", mode: 0o600 });
  console.log("Local configuration created.");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  console.log("Existing .env kept.");
}
console.log(
  "Next: npm run infra:up, npm run db:migrate, then npm run storage:bootstrap-local.",
);
