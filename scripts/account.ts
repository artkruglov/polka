import { createAccount } from "../apps/server/auth.ts";
import { db } from "../apps/server/db.ts";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const name = process.argv[2];
const generate = process.argv.includes("--generate");
if (!name || (process.stdin.isTTY && !generate)) {
  console.error(
    "Use npm run account:create -- artem --generate, or pass the password through standard input.",
  );
  process.exitCode = 1;
} else {
  let password = generate ? randomBytes(24).toString("base64url") : "";
  if (!generate) for await (const chunk of process.stdin) password += chunk;
  try {
    await createAccount(name, password.trim());
    if (generate) {
      await mkdir(".local", { recursive: true, mode: 0o700 });
      const path = `.local/${name}-account.txt`;
      await writeFile(path, `Логин: ${name}\nПароль: ${password}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      console.log(`Private shelf created. Credentials: ${path}`);
    } else console.log(`Account ${name} created with a private shelf.`);
  } finally {
    await db.end();
  }
}
