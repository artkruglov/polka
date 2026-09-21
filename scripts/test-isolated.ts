import pg from "pg";
import { randomBytes } from "node:crypto";
import {
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  CreateBucketCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { createS3Store } from "../packages/storage/s3.ts";
import { runMigrations } from "./migration-runner.ts";
import { SCHEMA_MIGRATIONS, migrationFileUrl } from "../packages/migrations.ts";

// Configuration locates local infrastructure only; neither configured DB nor bucket
// is a test target. Children receive random resources created by this process.
const source = new URL(process.env.DATABASE_URL!);
const endpoint = new URL(process.env.S3_ENDPOINT!);
for (const url of [source, endpoint])
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Tests require local PostgreSQL and S3 fixtures");
const suffix = randomBytes(12).toString("hex");
const name = `polka_suite_${suffix}`,
  bucket = `polka-suite-${suffix}`;
const target = new URL(source);
target.pathname = "/" + name;
const { s3 } = createS3Store({
  endpoint: endpoint.href,
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket,
});
const admin = new pg.Client({ connectionString: source.href });
await admin.connect();
let scratchDirectory: string | undefined;
let databaseCreated = false,
  bucketCreated = false;
const cleanup = {
  databaseRemoved: false,
  bucketRemoved: false,
  workingResourcesModified: false,
};
try {
  await admin.query(`CREATE DATABASE ${name}`);
  databaseCreated = true;
  const client = new pg.Client({ connectionString: target.href });
  await client.connect();
  try {
    await runMigrations(client, SCHEMA_MIGRATIONS, (file) =>
      readFile(migrationFileUrl(file), "utf8"),
    );
  } finally {
    await client.end();
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  bucketCreated = true;
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  let files: string[] = JSON.parse(
    await readFile(
      new URL("../tests/default-suite.json", import.meta.url),
      "utf8",
    ),
  );
  if (
    !files.length ||
    files.some((file) => !/^tests\/[a-z0-9-]+\.test\.ts$/.test(file))
  )
    throw Error("Invalid test suite manifest");
  const requestedFiles = process.argv.slice(2);
  if (requestedFiles.length) {
    if (requestedFiles.some(file => !files.includes(file)))
      throw Error("Select only test files registered in tests/default-suite.json");
    files = [...new Set(requestedFiles)];
  }
  const liveLibraryViewerFile = "tests/template-library-viewer.test.ts";
  const batches = [
    {
      files: files.filter((file) => file !== liveLibraryViewerFile),
      liveLibraryViewer: false,
    },
    ...(files.includes(liveLibraryViewerFile)
      ? [{ files: [liveLibraryViewerFile], liveLibraryViewer: true }]
      : []),
  ].filter((batch) => batch.files.length);
  console.log(
    JSON.stringify({
      event: "test-suite.selection",
      files,
      batches,
      fullSuite: !requestedFiles.length,
    }),
  );
  scratchDirectory = await mkdtemp(join(tmpdir(), "polka-suite-"));
  for (const name of await readdir(process.cwd())) {
    if ([".local", ".env", ".git"].includes(name)) continue;
    await symlink(join(process.cwd(), name), join(scratchDirectory, name));
  }
  await writeFile(
    join(scratchDirectory, ".env"),
    "# Test children inherit isolated configuration.\n",
    { mode: 0o600 },
  );
  let child: ReturnType<typeof spawn> | undefined;
  const interrupt = () => {
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    let result = 0;
    for (const batch of batches) {
      child = spawn(
        process.execPath,
        // Each file loads a TypeScript runtime and may spawn more processes.
        ["--import", "tsx", "--test", "--test-concurrency=4", ...batch.files],
        {
          stdio: "inherit",
          cwd: scratchDirectory,
          env: {
            ...process.env,
            DATABASE_URL: target.href,
            S3_BUCKET: bucket,
            MAIL_MODE: "local",
            URL_IMPORT_ENABLED: "false",
            HTML_LIVE_MODE: batch.liveLibraryViewer ? "local" : "disabled",
            HTML_LIVE_ENABLED: batch.liveLibraryViewer ? "true" : "false",
            ...(batch.liveLibraryViewer
              ? {
                  VIEWER_ORIGIN: "http://localhost:4391",
                  VIEWER_HOST: "localhost",
                  VIEWER_PORT: "4391",
                }
              : {}),
          },
        },
      );
      const code = await new Promise<number>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", (value) => resolve(value ?? 1));
      });
      if (code !== 0) result = code;
      child = undefined;
    }
    process.exitCode = result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
} catch {
  console.error(
    "Isolated test run failed; configured working resources were not selected.",
  );
  process.exitCode = 1;
} finally {
  try {
    if (bucketCreated) {
      // This bucket was created by this invocation, never reused or supplied by a user.
      while (true) {
        const page = await s3.send(
          new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
        );
        const objects = [
          ...(page.Versions ?? []),
          ...(page.DeleteMarkers ?? []),
        ].map((x) => ({ Key: x.Key!, VersionId: x.VersionId! }));
        if (!objects.length) break;
        const deleted = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (deleted.Errors?.length)
          throw Error("Scratch object cleanup failed");
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        throw Error("Scratch bucket remains");
      } catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
      }
      cleanup.bucketRemoved = true;
    }
  } catch {
    console.error("Scratch bucket cleanup failed.");
    process.exitCode = 1;
  }
  try {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      cleanup.databaseRemoved = !(
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])
      ).rowCount;
    }
  } catch {
    console.error("Scratch database cleanup failed.");
    process.exitCode = 1;
  }
  if (scratchDirectory)
    await rm(scratchDirectory, { recursive: true, force: true });
  await admin.end();
  s3.destroy();
  console.log(JSON.stringify({ event: "test-suite.cleanup", ...cleanup }));
}
