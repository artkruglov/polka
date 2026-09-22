import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { withdrawEditorial } from "../apps/server/editorial.ts";
import { db } from "../apps/server/db.ts";
import { publishEditorialOperatorInput } from "./editorial-operator.ts";

const uuid = z.string().uuid();
const args = process.argv.slice(2);
const command = z.enum(["publish", "withdraw"]).parse(args.shift());
if (!args.includes("--confirm-publication"))
  throw new Error("Pass --confirm-publication for an explicit operator action");

const value = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1]!;
};
const tenant = uuid.parse(value("--tenant"));
const owner = uuid.parse(value("--owner"));

let result;
try {
  if (command === "publish") {
    const inputPath = resolve(value("--input"));
    const encoded = await readFile(inputPath);
    if (encoded.length > 64 * 1024)
      throw new Error("Editorial manifest exceeds 64 KiB");
    result = await publishEditorialOperatorInput(
      { id: owner, tenant },
      JSON.parse(encoded.toString("utf8")),
    );
  } else {
    result = await withdrawEditorial(
      { id: owner, tenant },
      { publicationId: uuid.parse(value("--publication")) },
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "editorial.operator.failed", reason: "rejected" })}\n`,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
