import { z } from "zod";
const env = z
  .object({
    DATABASE_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(16),
    S3_BUCKET: z.string().min(3),
    LINK_KEY: z.string().min(64),
    APP_ORIGIN: z.string().url(),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().default(4390),
    COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  })
  .parse(process.env);
if (new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN)
  throw new Error("APP_ORIGIN must be an origin");
if (
  env.COOKIE_SECURE === "false" &&
  !["127.0.0.1", "localhost"].includes(new URL(env.APP_ORIGIN).hostname)
)
  throw new Error("Insecure cookies only supported on loopback");
export const config = env;
