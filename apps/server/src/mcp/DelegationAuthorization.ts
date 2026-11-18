import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the policy is a tiny file re-read per protected call so edits apply without a restart.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- hashes the recorded plan arguments, matching the router.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- joins the policy file path.
import * as NodePath from "node:path";

export const DELEGATION_POLICY_FILE = "delegation-policy.json";

export interface DelegationPolicy {
  readonly enforce: boolean;
  readonly planTtlMs: number;
  /** Substring identifying the router MCP server in the recorded tool name/source. */
  readonly routerToolMatch: string;
  /** Router plan registry; the only way to prove a plan for providers that record just a call summary. */
  readonly planDir: string | undefined;
  readonly source: "default" | "file" | "env" | "invalid";
}

/** Overrides where the server reads its policy; tests provide it, production reads `stateDir`. */
export class DelegationPolicySource extends Context.Service<
  DelegationPolicySource,
  {
    readonly load: Effect.Effect<DelegationPolicy>;
    readonly loadRegistry?: (
      policy: DelegationPolicy,
    ) => Effect.Effect<ReadonlyArray<RegistryPlan>>;
  }
>()("t3/mcp/DelegationAuthorization/DelegationPolicySource") {}

const DEFAULTS = {
  planTtlMs: 60 * 60_000,
  routerToolMatch: "t3-router",
  planDir: undefined,
} as const;

/**
 * Absent file and env = upstream behavior (no enforcement). A present but unreadable or malformed
 * file enforces: a broken policy must never silently switch the guard off.
 */
export const loadDelegationPolicy = (
  stateDir: string | undefined,
  env: Record<string, string | undefined> = process.env,
): DelegationPolicy => {
  const envOn = env.T3CODE_DELEGATION_ENFORCE === "1";
  if (stateDir === undefined) {
    return { enforce: envOn, ...DEFAULTS, source: envOn ? "env" : "default" };
  }
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(stateDir, DELEGATION_POLICY_FILE), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { enforce: envOn, ...DEFAULTS, source: envOn ? "env" : "default" };
    }
    return { enforce: true, ...DEFAULTS, source: "invalid" };
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (typeof json.enforce !== "boolean") throw new Error("enforce");
    const ttl = json.planTtlMinutes;
    const match = json.routerToolMatch;
    const planDir = json.planDir;
    return {
      enforce: json.enforce || envOn,
      planTtlMs: typeof ttl === "number" && ttl > 0 ? ttl * 60_000 : DEFAULTS.planTtlMs,
      routerToolMatch:
        typeof match === "string" && match.length > 0 ? match : DEFAULTS.routerToolMatch,
      planDir: typeof planDir === "string" && planDir.length > 0 ? planDir : undefined,
      source: "file",
    };
  } catch {
    return { enforce: true, ...DEFAULTS, source: "invalid" };
  }
};

/** What the router writes per `plan_work`: its identity is the digest of the arguments the model sent. */
export interface RegistryPlan extends Plan {
  /** Epoch seconds the router wrote the entry, i.e. while `plan_work` was running. */
  readonly ts?: unknown;
  readonly input_digest?: unknown;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );

/** Must match `plan_input_digest` in the router (`routing/planner.py`). */
export const planInputDigest = (input: unknown): string | undefined => {
  const raw = (input as { arguments?: unknown } | null)?.arguments ?? input;
  const args = raw as { goal?: unknown; lead_provider?: unknown; subtasks?: unknown } | null;
  if (!args || typeof args.goal !== "string" || !Array.isArray(args.subtasks)) return undefined;
  return NodeCrypto.createHash("sha256")
    .update(
      canonical({
        goal: args.goal,
        lead_provider: args.lead_provider ?? null,
        subtasks: args.subtasks,
      }),
    )
    .digest("hex");
};

export const loadPlanRegistry = (planDir: string | undefined): ReadonlyArray<RegistryPlan> => {
  if (planDir === undefined) return [];
  try {
    return NodeFS.readdirSync(planDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [
            JSON.parse(NodeFS.readFileSync(NodePath.join(planDir, name), "utf8")) as RegistryPlan,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** The slice of a recorded turn item the decision reads; the server wrote it, the model did not. */
export interface RecordedToolItem {
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null;
  readonly toolSource?: { readonly key?: string } | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly title?: string | null;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
  readonly updatedAt?: unknown;
}

export interface DelegationRequest {
  readonly callerThreadId: string | undefined;
  readonly callerInstanceId: string;
  readonly targetInstanceId: string;
  readonly planRef: string | undefined;
}

export type DelegationReason =
  | "not_enforced"
  | "same_provider"
  | "authorized"
  | "identity_missing"
  | "plan_ref_missing"
  | "plan_not_owned_by_thread"
  | "plan_expired"
  | "plan_not_delegatable"
  | "subtask_mismatch"
  | "provider_mismatch"
  | "lead_mismatch"
  | "policy_invalid";

export interface DelegationDecision {
  readonly allow: boolean;
  readonly reason: DelegationReason;
  readonly planId?: string;
}

interface Plan {
  readonly plan_id?: unknown;
  readonly decision?: unknown;
  readonly lead_provider?: unknown;
  readonly assignments?: unknown;
}

const textOf = (output: unknown): string[] => {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) {
    return output.flatMap((part) =>
      typeof part === "string"
        ? [part]
        : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? [(part as { text: string }).text]
          : [],
    );
  }
  return [];
};

const parsePlan = (output: unknown): Plan | undefined => {
  for (const text of textOf(output)) {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && typeof (value as Plan).plan_id === "string") {
        return value as Plan;
      }
    } catch {
      // Not the plan JSON (an error text, for one).
    }
  }
  return undefined;
};

const mentionsPlanWork = (item: RecordedToolItem) =>
  /plan[_ ]work/i.test(
    `${item.toolName ?? ""} ${item.title ?? ""} ${textOf(item.output).join(" ")}`,
  );

/** The store decodes timestamps to `DateTime`; fixtures and raw rows carry ISO strings. */
const toMs = (value: unknown): number => {
  if (typeof value === "string") return Date.parse(value);
  const dated = value as { epochMilliseconds?: unknown; toJSON?: () => unknown } | null;
  if (typeof dated?.epochMilliseconds === "number") return dated.epochMilliseconds;
  return typeof dated?.toJSON === "function" ? Date.parse(String(dated.toJSON())) : Number.NaN;
};

const wroteDuringCall = (entry: RegistryPlan, item: RecordedToolItem) => {
  const wroteMs = typeof entry.ts === "number" ? entry.ts * 1000 : Number.NaN;
  const startMs = toMs(item.startedAt);
  const endMs = toMs(item.completedAt);
  return wroteMs >= startMs - 2000 && wroteMs <= endMs + 2000;
};

const isRouterPlanWork = (item: RecordedToolItem, match: string) => {
  const name = item.toolName ?? "";
  return (
    /plan_work$/.test(name) &&
    (name.includes(match) || (item.toolSource?.key ?? "").includes(match))
  );
};

/**
 * Decides one delegation. `items` must come from the caller thread's own record: a plan counts
 * only when its `plan_work` result was recorded in that thread, so ownership is bound to the
 * server-held thread identity rather than to anything the model sends.
 */
export const decideDelegation = (
  policy: DelegationPolicy,
  request: DelegationRequest,
  items: ReadonlyArray<RecordedToolItem>,
  nowMs: number,
  registry: ReadonlyArray<RegistryPlan> = [],
): DelegationDecision => {
  if (!policy.enforce) return { allow: true, reason: "not_enforced" };
  if (request.targetInstanceId === request.callerInstanceId) {
    return { allow: true, reason: "same_provider" };
  }
  if (policy.source === "invalid") return { allow: false, reason: "policy_invalid" };
  if (!request.callerThreadId) return { allow: false, reason: "identity_missing" };
  if (!request.planRef) return { allow: false, reason: "plan_ref_missing" };
  const cut = request.planRef.indexOf(":");
  const planId = cut > 0 ? request.planRef.slice(0, cut) : request.planRef;
  const subtaskId = cut > 0 ? request.planRef.slice(cut + 1) : "";

  let owned: { plan: Plan; at: number } | undefined;
  for (const item of items) {
    if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
    const plan = isRouterPlanWork(item, policy.routerToolMatch)
      ? parsePlan(item.output)
      : undefined;
    // Providers that record only a free-form summary are proven by the digest of the recorded arguments,
    // and by the router writing the entry while that very call was running.
    const digest =
      plan === undefined && (item.toolName === "Tool" || mentionsPlanWork(item))
        ? planInputDigest(item.input)
        : undefined;
    const proven =
      plan ??
      (digest === undefined
        ? undefined
        : registry.find(
            (entry) =>
              entry.input_digest === digest &&
              entry.plan_id === planId &&
              wroteDuringCall(entry, item),
          ));
    if (proven?.plan_id !== planId) continue;
    const at = toMs(item.completedAt ?? item.updatedAt);
    if (!owned || at > owned.at) owned = { plan: proven, at };
  }
  if (!owned) return { allow: false, reason: "plan_not_owned_by_thread", planId };
  if (!Number.isFinite(owned.at) || nowMs - owned.at > policy.planTtlMs) {
    return { allow: false, reason: "plan_expired", planId };
  }
  if (owned.plan.decision !== "DELEGATE") {
    return { allow: false, reason: "plan_not_delegatable", planId };
  }
  if (
    typeof owned.plan.lead_provider === "string" &&
    owned.plan.lead_provider !== request.callerInstanceId
  ) {
    return { allow: false, reason: "lead_mismatch", planId };
  }
  const assignments = Array.isArray(owned.plan.assignments)
    ? (owned.plan.assignments as ReadonlyArray<Record<string, unknown>>)
    : [];
  const assignment = assignments.find(
    (candidate) => subtaskId !== "" && candidate.id === subtaskId,
  );
  if (!assignment || assignment.decision !== "DELEGATE") {
    return { allow: false, reason: "subtask_mismatch", planId };
  }
  if (assignment.provider !== request.targetInstanceId) {
    return { allow: false, reason: "provider_mismatch", planId };
  }
  return { allow: true, reason: "authorized", planId };
};
