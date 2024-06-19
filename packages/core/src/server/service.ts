import http from "node:http";
import type { Common } from "@/common/common.js";
import type { ReadonlyStore } from "@/indexing-store/store.js";
import type { Schema } from "@/schema/common.js";
import { getTables } from "@/schema/utils.js";
import type { DatabaseModel } from "@/types/model.js";
import type { UserRecord } from "@/types/schema.js";
import { startClock } from "@/utils/timer.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { createHttpTerminator } from "http-terminator";
import type { QueryResult } from "kysely";
import { onError, onNotFound } from "./error.js";

type Server = {
  hono: Hono;
  port: number;
  setHealthy: () => void;
  kill: () => Promise<void>;
};

export async function createServer({
  apps: userApps,
  schema,
  readonlyStore,
  query,
  common,
}: {
  apps?: Hono[];
  schema: Schema;
  readonlyStore: ReadonlyStore;
  query: (query: string) => Promise<QueryResult<unknown>>;
  common: Common;
}): Promise<Server> {
  // Create hono app

  const startTime = Date.now();
  let isHealthy = false;

  const ponderApp = new Hono()
    .use(cors())
    .get("/metrics", async (c) => {
      try {
        const metrics = await common.metrics.getMetrics();
        return c.text(metrics);
      } catch (error) {
        return c.json(error as Error, 500);
      }
    })
    .get("/health", async (c) => {
      if (isHealthy) {
        return c.text("", 200);
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const max = common.options.maxHealthcheckDuration;

      if (elapsed > max) {
        common.logger.warn({
          service: "server",
          msg: `Historical indexing duration has exceeded the max healthcheck duration of ${max} seconds (current: ${elapsed}). Sevice is now responding as healthy and may serve incomplete data.`,
        });
        return c.text("", 200);
      }

      return c.text("Historical indexing is not complete.", 503);
    })
    .get("/ready", async (c) => c.text("", 200));

  const metricsMiddleware = createMiddleware(async (c, next) => {
    const commonLabels = { method: c.req.method, path: c.req.path };
    common.metrics.ponder_http_server_active_requests.inc(commonLabels);
    const endClock = startClock();

    try {
      await next();
    } finally {
      const requestSize = Number(c.req.header("Content-Length") ?? 0);
      const responseSize = Number(c.res.headers.get("Content-Length") ?? 0);
      const responseDuration = endClock();
      const status =
        c.res.status >= 200 && c.res.status < 300
          ? "2XX"
          : c.res.status >= 300 && c.res.status < 400
            ? "3XX"
            : c.res.status >= 400 && c.res.status < 500
              ? "4XX"
              : "5XX";

      common.metrics.ponder_http_server_active_requests.dec(commonLabels);
      common.metrics.ponder_http_server_request_size_bytes.observe(
        { ...commonLabels, status },
        requestSize,
      );
      common.metrics.ponder_http_server_response_size_bytes.observe(
        { ...commonLabels, status },
        responseSize,
      );
      common.metrics.ponder_http_server_request_duration_ms.observe(
        { ...commonLabels, status },
        responseDuration,
      );
    }
  });

  const db = Object.keys(getTables(schema)).reduce<{
    [tableName: string]: Pick<
      DatabaseModel<UserRecord>,
      "findUnique" | "findMany"
    >;
  }>((acc, tableName) => {
    acc[tableName] = {
      findUnique: async ({ id }) => {
        common.logger.trace({
          service: "store",
          msg: `${tableName}.findUnique(id=${id})`,
        });
        return readonlyStore.findUnique({
          tableName,
          id,
        });
      },
      findMany: async ({ where, orderBy, limit, before, after } = {}) => {
        common.logger.trace({
          service: "store",
          msg: `${tableName}.findMany`,
        });
        return readonlyStore.findMany({
          tableName,
          where,
          orderBy,
          limit,
          before,
          after,
        });
      },
    };
    return acc;
  }, {});

  // @ts-ignore
  db.query = query;

  const contextMiddleware = createMiddleware(async (c, next) => {
    c.set("db", db);
    c.set("readonlyStore", readonlyStore);
    c.set("schema", schema);
    await next();
  });

  const hono = new Hono()
    .use(metricsMiddleware)
    .route("/_ponder", ponderApp)
    .use(contextMiddleware);

  if (userApps !== undefined) {
    const routes = new Set<string>();

    for (const app of userApps) {
      for (const route of app.routes) {
        // Validate user routes don't conflict with ponder routes
        if (route.path.startsWith("/_ponder")) {
          common.logger.warn({
            service: "server",
            msg: `Ingoring '${route.method}' handler for route '${route.path}' because '/_ponder' is reserved for internal use`,
          });
        }

        // Validate user routes don't conflict have duplicates
        const _route = `${route.method}_${route.path}`;
        if (routes.has(_route)) {
          common.logger.warn({
            service: "server",
            msg: `Path '${route.path}' with method '${route.method}' already has been defined`,
          });
        } else {
          routes.add(_route);
        }
      }

      hono.route("/", app);
    }

    common.logger.debug({
      service: "server",
      msg: `Detected a custom server with routes: [${userApps
        .flatMap((app) => app.routes.map((r) => r.path))
        .join(", ")}]`,
    });
  }

  if (userApps !== undefined) {
    for (const app of userApps) {
      hono.route(
        "/",
        app.onError((error, c) => onError(error, c, common)),
      );
    }
  }

  // Custom 404 error handling
  hono.notFound(onNotFound);

  // Create nodejs server

  let port = common.options.port;

  const createServerWithNextAvailablePort: typeof http.createServer = (
    ...args: any
  ) => {
    const httpServer = http.createServer(...args);

    const errorHandler = (error: Error & { code: string }) => {
      if (error.code === "EADDRINUSE") {
        common.logger.warn({
          service: "server",
          msg: `Port ${port} was in use, trying port ${port + 1}`,
        });
        port += 1;
        setTimeout(() => {
          httpServer.close();
          httpServer.listen(port, common.options.hostname);
        }, 5);
      }
    };

    const listenerHandler = () => {
      common.metrics.ponder_http_server_port.set(port);
      common.logger.info({
        service: "server",
        msg: `Started listening on port ${port}`,
      });
      httpServer.off("error", errorHandler);
    };

    httpServer.on("error", errorHandler);
    httpServer.on("listening", listenerHandler);

    return httpServer;
  };

  const httpServer = await new Promise<http.Server>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("HTTP server failed to start within 5 seconds."));
    }, 5_000);

    const httpServer = serve(
      {
        fetch: hono.fetch,
        createServer: createServerWithNextAvailablePort,
        port,
        // Note that common.options.hostname can be undefined if the user did not specify one.
        // In this case, Node.js uses `::` if IPv6 is available and `0.0.0.0` otherwise.
        // https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback
        hostname: common.options.hostname,
      },
      () => {
        clearTimeout(timeout);
        resolve(httpServer as http.Server);
      },
    );
  });

  const terminator = createHttpTerminator({
    server: httpServer,
    gracefulTerminationTimeout: 1000,
  });

  return {
    hono,
    port,
    setHealthy: () => {
      isHealthy = true;
    },
    kill: () => terminator.terminate(),
  };
}
