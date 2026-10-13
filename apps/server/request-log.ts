import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { recordRequest } from "./ops-prometheus.ts";

/** A request id for Fastify (createApp): random, so ids never repeat across restarts. */
export const requestId = () => randomUUID();

// Probes from Docker and the uptime monitor: counted, logged only at debug.
const PROBES = new Set(["/healthz", "/readyz", "/api/health"]);

/**
 * One log line per request and its request id for the client:
 * `{"event":"request","method":"GET","route":"/api/works/:id","status":200,
 * "ms":12.3,"reqId":"…"}`. The route is the pattern Fastify matched, never
 * the URL: URLs carry share tokens and ids. A request no route matched is
 * "unmatched". The same labels feed the Prometheus histogram
 * (ops-prometheus.ts). ACCESS_LOG picks the level, or turns the lines off.
 */
export function registerRequestLog(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    const ms = reply.elapsedTime;
    recordRequest(req.method, route, reply.statusCode, ms / 1000);
    if (config.ACCESS_LOG === "off") return;
    const level = PROBES.has(route) ? "debug" : config.ACCESS_LOG;
    log[level]({
      event: "request",
      method: req.method,
      route,
      status: reply.statusCode,
      ms: Math.round(ms * 10) / 10,
      reqId: req.id,
    });
  });
}
