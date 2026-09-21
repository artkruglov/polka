import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerHealthRoutes } from "../apps/server/health-routes.ts";

function assertPublicHealthHeaders(headers: Record<string, unknown>) {
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-robots-tag"], "noindex, nofollow, noarchive");
  assert.equal(headers["referrer-policy"], "no-referrer");
}

test("health routes expose only generic live and ready states", async (t) => {
  let alive = true;
  let ready = true;
  const app = Fastify();
  await registerHealthRoutes(app, {
    alive: () => alive,
    ready: async () => ready,
  });
  t.after(() => app.close());

  const liveResponse = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(liveResponse.statusCode, 200);
  assert.deepEqual(liveResponse.json(), { status: "alive" });
  assertPublicHealthHeaders(liveResponse.headers);

  const readyResponse = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(readyResponse.statusCode, 200);
  assert.deepEqual(readyResponse.json(), { status: "ready" });
  assertPublicHealthHeaders(readyResponse.headers);

  ready = false;
  const dependencyFailure = await app.inject({
    method: "GET",
    url: "/readyz",
  });
  assert.equal(dependencyFailure.statusCode, 503);
  assert.deepEqual(dependencyFailure.json(), { status: "not_ready" });

  alive = false;
  const stopping = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(stopping.statusCode, 503);
  assert.deepEqual(stopping.json(), { status: "stopping" });
});

test("readiness fails closed without exposing probe failures", async (t) => {
  const app = Fastify();
  await registerHealthRoutes(app, {
    alive: () => true,
    ready: async () => {
      throw new Error("postgresql://user:password@private-db/private");
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: "not_ready" });
  assert.doesNotMatch(response.body, /password|postgres|private-db/i);
  assertPublicHealthHeaders(response.headers);
});
