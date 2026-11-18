// Author / Agent: Codex
// Read-only native control probes. No model prompt, config writes or credential output.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Standalone CLI reads configuration before building the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Standalone CLI resolves the settings path before building the Effect runtime.
import * as NodePath from "node:path";
import { probeClaudeCapabilities } from "../src/provider/ClaudeProvider.ts";
import { withCodexAppServerClient } from "../src/provider/CodexProvider.ts";
import { makeAntigravityUsageProbe } from "../src/provider/antigravityUsageLimits.ts";
import { resolveAntigravityInstanceDirectories } from "../src/provider/antigravityAuthSupport.ts";
import { claudeUsageResponseToLimits } from "../src/provider/claudeUsageLimits.ts";
import { codexRateLimitsToLimits } from "../src/provider/codexUsageLimits.ts";

import {
  routerProbeEnvironment,
  selectRouterProbeInstance,
} from "../src/provider/routerUsageProbeConfig.ts";

const stateDir = NodePath.join(NodeOS.homedir(), ".t3", "userdata");
// Read the same instance selection as T3. Never guess another installed CLI/account.
// Custom environment/secret resolution is intentionally unsupported by this bridge.
const settings = await NodeFSP.readFile(NodePath.join(stateDir, "settings.json"), "utf8").then(
  JSON.parse,
);
const instance = (driver: string) => selectRouterProbeInstance(settings, driver);

const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const providers = {
  codex: Effect.gen(function* () {
    const selected = instance("codex");
    if (!selected) return undefined;
    const config = yield* decodeCodex(selected.config);
    const { client } = yield* withCodexAppServerClient({
      binaryPath: config.binaryPath,
      homePath: config.homePath,
      cwd: NodeOS.tmpdir(),
    });
    const result = yield* client.request("account/rateLimits/read", null);
    return codexRateLimitsToLimits({
      ...result,
      snapshot: result.rateLimits,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    });
  }),
  claudeAgent: Effect.gen(function* () {
    const selected = instance("claudeAgent");
    if (!selected) return undefined;
    const result = yield* probeClaudeCapabilities(
      yield* decodeClaude(selected.config),
      routerProbeEnvironment(process.env),
      NodeOS.tmpdir(),
    );
    if (!result.usage || !result.usageCheckedAt) return undefined;
    return claudeUsageResponseToLimits({ response: result.usage, checkedAt: result.usageCheckedAt })
      .limits;
  }),
  antigravity: Effect.gen(function* () {
    const selected = instance("antigravity");
    if (!selected || selected.config.authMethod !== "oauth-personal") return undefined;
    const directories = yield* resolveAntigravityInstanceDirectories(
      stateDir,
      ProviderInstanceId.make(selected.id),
    );
    const usage = yield* makeAntigravityUsageProbe({
      profileDirectory: directories.profile,
      authMethod: "oauth-personal",
    });
    return yield* usage.probe;
  }),
};

const sanitize = <E, R>(
  provider: string,
  probe: Effect.Effect<ServerProviderUsageLimits | undefined, E, R>,
) =>
  probe.pipe(
    Effect.scoped,
    Effect.timeout("35 seconds"),
    Effect.map((limits) => ({
      provider,
      status: limits && !limits.unavailable ? "ok" : "unavailable",
      // Strict allowlist: never serialize account identity, credentials or SDK errors.
      checkedAt: limits?.checkedAt,
      windows:
        limits?.windows.map(({ id, kind, usedPercent, resetsAt, windowDurationMins }) => ({
          id,
          kind,
          usedPercent,
          resetsAt,
          windowDurationMins,
        })) ?? [],
    })),
    Effect.catchCause(() => Effect.succeed({ provider, status: "probe-failed", windows: [] })),
  );
const program = Effect.all(
  [
    sanitize("codex", providers.codex),
    sanitize("claudeAgent", providers.claudeAgent),
    sanitize("antigravity", providers.antigravity),
  ],
  { concurrency: "unbounded" },
);

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer, Logger.layer([])),
    ),
  ),
);
process.stdout.write(JSON.stringify({ version: 1, providers: result }) + "\n");
