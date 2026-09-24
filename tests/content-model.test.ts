// The model stage's endpoints (docs/specs/CONTENT_FILTER.md, «Модели»):
// configuration per role (hosts, the NeuralDeep model allowlist, defaults),
// provider headers, 429 and the in-process limiter, prices and flat rates.
// Mocked HTTP only; no database, no real calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RateLimiter,
  limiterFor,
  providerHeaders,
  resetLimiters,
  retryAfterMs,
} from "../apps/server/content-filter/endpoints.ts";
import {
  budgetCost,
  chatModelClient,
  costOf,
  parsePrices,
} from "../apps/server/content-filter/model.ts";
import { codeReviewer } from "../apps/server/content-filter/code-model.ts";

const baseEnv = {
  DATABASE_URL: "postgres://runtime:password@example.invalid:5432/polka",
  S3_ENDPOINT: "https://objects.example.invalid",
  S3_ACCESS_KEY: "synthetic-access",
  S3_SECRET_KEY: "synthetic-storage-secret",
  S3_BUCKET: "synthetic-bucket",
  LINK_KEY: "a".repeat(64),
  APP_ORIGIN: "https://app.example.invalid",
  HOST: "127.0.0.1",
  PORT: "4390",
  HTML_LIVE_ENABLED: "false",
  VIEWER_ORIGIN: "http://localhost:4391",
  VIEWER_HOST: "localhost",
  VIEWER_PORT: "4391",
  MAIL_MODE: "disabled",
  COOKIE_SECURE: "true",
};

type Endpoint = {
  provider: string;
  url: string;
  key: string | null;
  rpm: number;
  concurrency: number;
  flatRate: boolean;
};
type Endpoints = {
  primary: Endpoint;
  fallback: Endpoint | null;
  code: Endpoint | null;
};

/** The endpoints a configuration yields, or the error it refuses to start with. */
function endpoints(
  extra: Record<string, string>,
): Endpoints | { error: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import('./apps/server/config.ts').then(({config}) => console.log(JSON.stringify(config.CONTENT_MODEL_ENDPOINTS)))",
    ],
    {
      cwd: process.cwd(),
      env: { ...baseEnv, ...extra },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined, String(result.error));
  if (result.status !== 0) return { error: result.stderr };
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}
const ok = (value: Endpoints | { error: string }) => {
  assert.ok(!("error" in value), "error" in value ? value.error : "");
  return value as Endpoints;
};
const refused = (value: Endpoints | { error: string }, pattern: RegExp) => {
  assert.ok("error" in value, "expected a refusal");
  assert.match((value as { error: string }).error, pattern);
};

const YANDEX = "https://llm.api.cloud.yandex.net/v1/chat/completions";
const ND = "https://api.neuraldeep.ru/v1/chat/completions";

test("config: the current Yandex-only configuration keeps one endpoint for every role", () => {
  const all = ok(
    endpoints({
      CONTENT_MODEL_PROVIDER: "yandex",
      CONTENT_MODEL_PRIMARY: "gpt://f/qwen3.6-35b-a3b/latest",
      CONTENT_MODEL_FALLBACK: "gpt://f/gpt-oss-120b/latest",
      CONTENT_CODE_MODEL: "gpt://f/deepseek-v4-flash/latest",
      CONTENT_MODEL_API_KEY: "yandex-key",
    }),
  );
  for (const role of [all.primary, all.fallback!, all.code!])
    assert.deepEqual(role, {
      provider: "yandex",
      url: YANDEX,
      key: "yandex-key",
      rpm: 0,
      concurrency: 0,
      flatRate: false,
    });
  assert.equal(endpoints({}), null, "off: no endpoints");
});

test("config: NeuralDeep primary, Yandex fallback; keys never cross endpoints", () => {
  const roles = ok(
    endpoints({
      CONTENT_MODEL_PROVIDER: "neuraldeep",
      CONTENT_MODEL_PRIMARY: "qwen3.6-35b-a3b-noreason",
      CONTENT_MODEL_API_KEY: "nd-key",
      CONTENT_MODEL_FLAT_RATE: "true",
      CONTENT_MODEL_FALLBACK_PROVIDER: "yandex",
      CONTENT_MODEL_FALLBACK: "gpt://f/gpt-oss-120b/latest",
      CONTENT_CODE_MODEL: "qwen3.6-35b-a3b-noreason",
    }),
  );
  assert.deepEqual(roles.primary, {
    provider: "neuraldeep",
    url: ND,
    key: "nd-key",
    rpm: 20,
    concurrency: 3,
    flatRate: true,
  });
  // Another provider: its own URL, no key of the primary, its own limits.
  assert.deepEqual(roles.fallback, {
    provider: "yandex",
    url: YANDEX,
    key: null,
    rpm: 0,
    concurrency: 0,
    flatRate: false,
  });
  // The same endpoint: the primary's key, limits and flat rate.
  assert.deepEqual(roles.code, roles.primary);
  const own = ok(
    endpoints({
      CONTENT_MODEL_PROVIDER: "neuraldeep",
      CONTENT_MODEL_URL: "https://api.neuraldeep.ru/v1",
      CONTENT_MODEL_PRIMARY: "qwen3.8-27b-noreason",
      CONTENT_MODEL_RPM: "30",
      CONTENT_MODEL_FALLBACK_PROVIDER: "yandex",
      CONTENT_MODEL_FALLBACK: "gpt://f/gpt-oss-120b/latest",
      CONTENT_MODEL_FALLBACK_API_KEY: "yandex-key",
      CONTENT_MODEL_FALLBACK_RPM: "60",
      CONTENT_CODE_MODEL: "qwen3.6-35b-a3b-noreason",
      CONTENT_CODE_MODEL_API_KEY: "nd-other-key",
      CONTENT_CODE_MODEL_MAX_CONCURRENCY: "1",
    }),
  );
  assert.equal(own.primary.url, ND, "a …/v1 base gets /chat/completions");
  assert.equal(own.primary.rpm, 30);
  assert.equal(own.fallback!.key, "yandex-key");
  assert.equal(own.fallback!.rpm, 60);
  assert.equal(own.code!.key, "nd-other-key");
  assert.equal(own.code!.concurrency, 1);
  assert.equal(own.code!.flatRate, false);
});

test("config: hosted.env.example starts as NeuralDeep primary and code model, Yandex fallback", () => {
  const example = Object.fromEntries(
    readFileSync("deploy/hosted/hosted.env.example", "utf8")
      .split("\n")
      .filter((line) => /^CONTENT_(MODEL|CODE_MODEL)_?[A-Z_]*=/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [
          line.slice(0, at),
          line.slice(at + 1).replaceAll("<folder>", "b1gexample"),
        ];
      }),
  );
  const roles = ok(endpoints(example));
  assert.equal(roles.primary.provider, "neuraldeep");
  assert.equal(roles.primary.url, ND);
  assert.equal(roles.primary.rpm, 20);
  assert.equal(roles.primary.concurrency, 3);
  assert.equal(roles.fallback!.provider, "yandex");
  assert.equal(roles.fallback!.url, YANDEX);
  assert.equal(roles.fallback!.rpm, 0);
  assert.deepEqual(roles.code, roles.primary);
  // The prices parse, and NeuralDeep's list prices are the built-in ones.
  const table = parsePrices(example.CONTENT_MODEL_PRICES_RUB!);
  const usage = { prompt_tokens: 1000, completion_tokens: 1000 };
  for (const model of [
    "qwen3.6-35b-a3b-noreason",
    "gemma-4-31b",
    "gpt-oss-120b",
    "qwen3.8-27b",
  ])
    assert.ok(
      Math.abs(
        costOf(model, usage, "neuraldeep", table) -
          costOf(model, usage, "neuraldeep", []),
      ) < 1e-9,
      model,
    );
});

test("config: host rules for every role and the NeuralDeep model allowlist", () => {
  const nd = {
    CONTENT_MODEL_PROVIDER: "neuraldeep",
    CONTENT_MODEL_PRIMARY: "qwen3.6-35b-a3b-noreason",
  };
  refused(
    endpoints({
      ...nd,
      CONTENT_MODEL_URL: "https://neuraldeep.example.com/v1/chat/completions",
    }),
    /CONTENT_MODEL_URL must be https:\/\/api\.neuraldeep\.ru/,
  );
  refused(
    endpoints({
      ...nd,
      CONTENT_MODEL_URL: "http://api.neuraldeep.ru/v1/chat/completions",
    }),
    /CONTENT_MODEL_URL must be https/,
  );
  // Wallet models may be served abroad: a cross-border transfer.
  for (const model of [
    "deepseek-v4-flash",
    "glm-5",
    "kimi-k2.6",
    "qwen3.6-35b-a3b-extra",
  ])
    refused(
      endpoints({ ...nd, CONTENT_MODEL_PRIMARY: model }),
      /not in CONTENT_MODEL_ND_ALLOWED/,
    );
  refused(
    endpoints({ ...nd, CONTENT_MODEL_FALLBACK: "glm-5" }),
    /CONTENT_MODEL_FALLBACK: «glm-5» is not in CONTENT_MODEL_ND_ALLOWED/,
  );
  refused(
    endpoints({ ...nd, CONTENT_CODE_MODEL: "deepseek-v4-flash" }),
    /CONTENT_CODE_MODEL: «deepseek-v4-flash» is not in CONTENT_MODEL_ND_ALLOWED/,
  );
  // NeuralDeep's catalogue marks these «вне РФ»: refused by default.
  for (const foreign of ["gpt-oss-120b", "gemma-4-31b-noreason"])
    refused(
      endpoints({ ...nd, CONTENT_MODEL_PRIMARY: foreign }),
      /not in CONTENT_MODEL_ND_ALLOWED/,
    );
  // The operator may narrow the list; empty (as compose passes it) is the default.
  refused(
    endpoints({ ...nd, CONTENT_MODEL_ND_ALLOWED: "gemma-4-31b" }),
    /not in CONTENT_MODEL_ND_ALLOWED/,
  );
  ok(
    endpoints({
      ...nd,
      CONTENT_MODEL_ND_ALLOWED: "",
      CONTENT_MODEL_URL: "",
      CONTENT_MODEL_RPM: "",
    }),
  );
  // A Yandex role needs a Yandex host; another provider's role its own rules.
  refused(
    endpoints({
      ...nd,
      CONTENT_MODEL_FALLBACK_PROVIDER: "yandex",
      CONTENT_MODEL_FALLBACK: "gpt://f/gpt-oss-120b/latest",
      CONTENT_MODEL_FALLBACK_URL:
        "https://api.neuraldeep.ru/v1/chat/completions",
    }),
    /CONTENT_MODEL_FALLBACK_URL is not a Yandex Cloud address/,
  );
  refused(
    endpoints({
      ...nd,
      CONTENT_CODE_MODEL_PROVIDER: "openai-compatible",
      CONTENT_CODE_MODEL: "any",
      CONTENT_CODE_MODEL_URL: "https://openrouter.ai/api/v1/chat/completions",
    }),
    /CONTENT_CODE_MODEL_URL must be a self-hosted model/,
  );
  refused(
    endpoints({
      ...nd,
      CONTENT_CODE_MODEL_PROVIDER: "openai-compatible",
      CONTENT_CODE_MODEL: "any",
    }),
    /CONTENT_CODE_MODEL_URL is required/,
  );
  ok(
    endpoints({
      ...nd,
      CONTENT_CODE_MODEL_PROVIDER: "openai-compatible",
      CONTENT_CODE_MODEL: "any",
      CONTENT_CODE_MODEL_URL: "http://10.0.0.5:8000/v1/chat/completions",
    }),
  );
  refused(
    endpoints({
      CONTENT_MODEL_PROVIDER: "yandex",
      CONTENT_MODEL_PRIMARY: "gpt://f/qwen3.6-35b-a3b/latest",
      CONTENT_MODEL_URL: ND,
    }),
    /CONTENT_MODEL_URL is not a Yandex Cloud address/,
  );
});

type Sent = { url: string; headers: Record<string, string>; body: any };
function fakeFetch(
  reply: (sent: Sent) => Response | Promise<Response>,
  sent: Sent[] = [],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const request = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    sent.push(request);
    return reply(request);
  }) as unknown as typeof fetch;
}
const answer = (
  content: string,
  usage = { prompt_tokens: 1000, completion_tokens: 100 },
) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const SAFE = '{"category":"safe","confidence":1,"reason":""}';
const endpoint = (
  provider: "yandex" | "neuraldeep",
  url: string,
  extra = {},
) => ({
  provider,
  url,
  key: `${provider}-key`,
  rpm: 0,
  concurrency: 0,
  flatRate: false,
  ...extra,
});

test("headers: Api-Key and no logging on Yandex, Bearer and no Yandex header on NeuralDeep", async () => {
  resetLimiters();
  assert.deepEqual(providerHeaders("yandex", "k"), {
    "content-type": "application/json",
    authorization: "Api-Key k",
    "x-data-logging-enabled": "false",
  });
  assert.deepEqual(providerHeaders("neuraldeep", "k"), {
    "content-type": "application/json",
    authorization: "Bearer k",
  });
  assert.deepEqual(providerHeaders("openai-compatible", null), {
    "content-type": "application/json",
  });
  const sent: Sent[] = [];
  const nd = chatModelClient({
    endpoint: endpoint("neuraldeep", ND),
    model: "qwen3.6-35b-a3b-noreason",
    timeoutMs: 1000,
    extra: {},
    maxTokens: 200,
    fetch: fakeFetch(() => answer(SAFE), sent),
  });
  assert.equal(
    ((await nd.classify({ text: "текст" })) as any).category,
    "none",
  );
  assert.equal(sent[0]!.url, ND);
  assert.equal(sent[0]!.headers.authorization, "Bearer neuraldeep-key");
  assert.equal("x-data-logging-enabled" in sent[0]!.headers, false);
  assert.equal(sent[0]!.body.model, "qwen3.6-35b-a3b-noreason");
  const reviewer = codeReviewer({
    endpoint: endpoint("yandex", YANDEX),
    model: "gpt://f/deepseek-v4-flash/latest",
    timeoutMs: 1000,
    extra: {},
    fetch: fakeFetch(
      () => answer('{"verdict":"safe","category":"","reasons":[]}'),
      sent,
    ),
  });
  assert.equal(((await reviewer.review("let a = 1")) as any).verdict, "safe");
  assert.equal(sent[1]!.headers.authorization, "Api-Key yandex-key");
  assert.equal(sent[1]!.headers["x-data-logging-enabled"], "false");
});

test("429: rate_limited, not an error, and the endpoint pauses for Retry-After", async () => {
  resetLimiters();
  const sent: Sent[] = [];
  let status = 429;
  const client = chatModelClient({
    endpoint: endpoint("neuraldeep", ND),
    model: "qwen3.6-35b-a3b-noreason",
    timeoutMs: 1000,
    extra: {},
    maxTokens: 200,
    fetch: fakeFetch(
      () =>
        status === 429
          ? new Response("slow down", {
              status: 429,
              headers: { "retry-after": "30" },
            })
          : status === 500
            ? new Response("", { status: 500 })
            : answer(SAFE),
      sent,
    ),
  });
  assert.deepEqual(await client.classify({ text: "a" }), {
    failed: "rate_limited",
    model: "qwen3.6-35b-a3b-noreason",
    costRub: 0,
  });
  // Paused longer than the request could wait: refused without a request.
  status = 200;
  assert.equal(
    ((await client.classify({ text: "b" })) as any).failed,
    "rate_limited",
  );
  assert.equal(sent.length, 1);
  // Another endpoint (another key) is not paused; a 500 is an error.
  resetLimiters();
  status = 500;
  assert.equal(((await client.classify({ text: "c" })) as any).failed, "error");
  const reviewer = codeReviewer({
    endpoint: endpoint("neuraldeep", ND),
    model: "qwen3.6-35b-a3b-noreason",
    timeoutMs: 1000,
    extra: {},
    fetch: fakeFetch(() => new Response("", { status: 429 })),
  });
  assert.deepEqual(await reviewer.review("x"), {
    failed: "rate_limited",
    costRub: 0,
  });
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs(null), 10_000);
  assert.equal(retryAfterMs("3600"), 60_000);
});

test("limiter: parallel requests wait for a slot; a full minute refuses at once", async () => {
  const parallel = new RateLimiter(0, 1);
  const first = await parallel.acquire(1000);
  assert.ok(first);
  const second: { release?: (() => void) | null } = {};
  const waiting = parallel
    .acquire(1000)
    .then((release) => (second.release = release));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second.release, undefined, "the second request waits");
  first!();
  await waiting;
  assert.ok(second.release, "and starts when the first ends");
  (second.release as () => void)();
  assert.equal(await new RateLimiter(0, 1).acquire(0).then((r) => !!r), true);
  const busy = new RateLimiter(0, 1);
  await busy.acquire(10);
  assert.equal(await busy.acquire(30), null, "no slot within the deadline");
  // 2 per minute on a fake clock.
  let now = 1_000_000;
  const perMinute = new RateLimiter(2, 0, () => now);
  (await perMinute.acquire(1000))!();
  (await perMinute.acquire(1000))!();
  assert.equal(await perMinute.acquire(5000), null, "the minute is full");
  now += 60_000;
  assert.ok(await perMinute.acquire(1000), "a new minute");
  // Roles on one endpoint share its limiter; the stricter limits win.
  resetLimiters();
  const a = limiterFor({ url: ND, key: "k", rpm: 20, concurrency: 3 });
  const b = limiterFor({ url: ND, key: "k", rpm: 30, concurrency: 1 });
  assert.equal(a, b);
  assert.equal(a.rpm, 20);
  assert.equal(a.concurrency, 1);
  assert.notEqual(
    limiterFor({ url: ND, key: "other", rpm: 20, concurrency: 3 }),
    a,
  );
});

test("prices: by model name and provider; NeuralDeep list prices; a flat rate costs nothing", async () => {
  resetLimiters();
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const cached = {
    prompt_tokens: 1_000_000,
    prompt_tokens_details: { cached_tokens: 1_000_000 },
    completion_tokens: 0,
  };
  const none = parsePrices("");
  const close = (a: number, b: number) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
  close(
    costOf("qwen3.6-35b-a3b-noreason", usage, "neuraldeep", none),
    7.14 + 40.8,
  );
  close(costOf("qwen3.6-35b-a3b-noreason", cached, "neuraldeep", none), 0.714);
  close(costOf("gemma-4-31b", usage, "neuraldeep", none), 11 + 37.4);
  close(costOf("gpt-oss-120b", usage, "neuraldeep", none), 5.1 + 20.4);
  close(
    costOf("qwen3.8-27b-noreason", usage, "neuraldeep", none),
    24.48 + 122.4,
  );
  // An unlisted NeuralDeep model: the dearest known price.
  close(costOf("gpt-oss-20b", usage, "neuraldeep", none), 2 * 122.4);
  // The same model on Yandex keeps the Yandex entry; a provider entry wins.
  const table = parsePrices(
    "gpt-oss-120b=0.30/0.30/0.30,qwen3.6=0.1/0.1/0.1,qwen3.6-35b-a3b=0.20/0.05/0.30,neuraldeep:gemma-4-31b=0.02/0.002/0.05",
  );
  close(costOf("gpt://f/gpt-oss-120b/latest", usage, "yandex", table), 600);
  close(costOf("gpt-oss-120b", usage, "neuraldeep", table), 5.1 + 20.4);
  close(costOf("gpt://f/qwen3.6-35b-a3b/latest", usage, "yandex", table), 500);
  close(costOf("gemma-4-31b", usage, "neuraldeep", table), 70);
  close(
    costOf("gpt://f/unknown/latest", { prompt_tokens: 1000 }, "yandex", table),
    0.3,
  );
  assert.throws(() => parsePrices("qwen=1/2"));
  // A flat-rate key: 0 for the budget whatever the usage.
  assert.equal(
    budgetCost(
      { provider: "neuraldeep", flatRate: true },
      "qwen3.6-unlim",
      usage,
    ),
    0,
  );
  const flat = chatModelClient({
    endpoint: endpoint("neuraldeep", ND, { flatRate: true }),
    model: "qwen3.6-unlim-noreason",
    timeoutMs: 1000,
    extra: {},
    maxTokens: 200,
    fetch: fakeFetch(() => answer(SAFE, usage)),
  });
  assert.equal(flat.flatRate, true);
  assert.equal((await flat.classify({ text: "a" })).costRub, 0);
  const paid = chatModelClient({
    endpoint: endpoint("neuraldeep", ND, { key: "paid" }),
    model: "qwen3.6-35b-a3b-noreason",
    timeoutMs: 1000,
    extra: {},
    maxTokens: 200,
    fetch: fakeFetch(() =>
      answer(SAFE, { prompt_tokens: 1000, completion_tokens: 100 }),
    ),
  });
  assert.ok((await paid.classify({ text: "a" })).costRub > 0);
});
