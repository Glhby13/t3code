import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as DelegationAuthorization from "./DelegationAuthorization.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const NOW = Date.parse("2026-11-18T14:00:00.000Z");
const MINUTE = 60_000;

const instances = {
  claude: ProviderInstanceId.make("claudeAgent"),
  codex: ProviderInstanceId.make("codex"),
  antigravity: ProviderInstanceId.make("antigravity"),
} as const;
type Lead = keyof typeof instances;

const threadA = ThreadId.make("thread:authz-a");
const threadB = ThreadId.make("thread:authz-b");
const projectId = ProjectId.make("project:authz");

const enforcing: DelegationAuthorization.DelegationPolicy = {
  enforce: true,
  planTtlMs: 60 * MINUTE,
  routerToolMatch: "t3-router",
  planDir: undefined,
  source: "file",
};

const planItem = (input: {
  readonly planId: string;
  readonly lead: Lead;
  readonly assignments: ReadonlyArray<{ id: string; provider: Lead; decision?: string }>;
  readonly ageMinutes?: number;
  readonly toolName?: string;
}) => ({
  type: "dynamic_tool",
  status: "completed",
  toolName: input.toolName ?? "t3-router.plan_work",
  completedAt: DateTime.makeUnsafe(NOW - (input.ageMinutes ?? 1) * MINUTE),
  output: [
    {
      type: "text",
      text: JSON.stringify({
        plan_id: input.planId,
        decision: "DELEGATE",
        lead_provider: instances[input.lead],
        assignments: input.assignments.map((assignment) => ({
          id: assignment.id,
          task_id: `${input.planId}:${assignment.id}`,
          provider: instances[assignment.provider],
          decision: assignment.decision ?? "DELEGATE",
        })),
      }),
    },
  ],
});

interface ThreadSpec {
  readonly lead: Lead;
  readonly items: ReadonlyArray<unknown>;
}

const provider = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [{ slug: "m1", name: "m1", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const scopeFor = (threadId: ThreadId, lead: Lead): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:authz"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: instances[lead],
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** Real OrchestratorMcpService.delegateTask over a mocked store holding each thread's recorded items. */
const harness = (
  specs: Record<string, ThreadSpec>,
  policy = enforcing,
  registry: ReadonlyArray<DelegationAuthorization.RegistryPlan> = [],
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<
      ReadonlyArray<{ parentThreadId: string; task: string; instanceId: string }>
    >([]);
    const delegatedBy = new Map<string, unknown>();
    const projection = (threadId: string) => {
      const spec = specs[threadId];
      if (spec === undefined) return undefined;
      const modelSelection = { instanceId: instances[spec.lead], model: "m1" };
      return {
        thread: {
          id: threadId,
          projectId,
          title: threadId,
          createdBy: "user",
          creationSource: "web",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        runs: [
          {
            id: RunId.make(`run:${threadId}`),
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make(`node:${threadId}`),
            providerInstanceId: instances[spec.lead],
            modelSelection,
          },
        ],
        contextTransfers: [],
        subagents: delegatedBy.has(threadId) ? [delegatedBy.get(threadId)] : [],
        turnItems: spec.items,
      } as unknown as OrchestrationV2ThreadProjection;
    };
    const all = Object.values(instances);
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(DelegationAuthorization.DelegationPolicySource, {
        load: Effect.succeed(policy),
        loadRegistry: () => Effect.succeed(registry),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        assertProviderInstanceEnabled: () => Effect.void,
        getThreadRecords: (threadId) =>
          Effect.succeed(
            projection(threadId) ??
              ({
                thread: { id: threadId, title: "Child" },
                runs: [],
                contextTransfers: [],
                messages: [],
                subagents: [],
                providerThreads: [],
                providerTurns: [],
                runtimeRequests: [],
                turnItems: [],
              } as unknown as OrchestrationV2ThreadProjection),
          ),
        dispatch: (command) => {
          const request = command as unknown as {
            parentThreadId: string;
            task: string;
            modelSelection: { instanceId: string };
          };
          const task = {
            id: NodeId.make(`node:task:${request.parentThreadId}`),
            threadId: request.parentThreadId,
            runId: RunId.make(`run:${request.parentThreadId}`),
            parentNodeId: NodeId.make(`node:${request.parentThreadId}`),
            origin: "app_owned",
            createdBy: "agent",
            driver: ProviderDriverKind.make(request.modelSelection.instanceId),
            providerInstanceId: request.modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: ThreadId.make(`thread:child:${request.parentThreadId}`),
            nativeTaskRef: null,
            prompt: request.task,
            title: null,
            model: "m1",
            status: "running",
            result: null,
            startedAt: null,
            completedAt: null,
          };
          delegatedBy.set(request.parentThreadId, task);
          return Ref.update(dispatched, (list) => [
            ...list,
            {
              parentThreadId: request.parentThreadId,
              task: request.task,
              instanceId: request.modelSelection.instanceId,
            },
          ]).pipe(
            Effect.as({
              sequence: 1,
              storedEvents: [
                {
                  sequence: 1,
                  commandId: null,
                  event: { type: "subagent.updated", payload: task },
                },
              ],
            } as never),
          );
        },
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(all.map(provider)),
        refreshInstance: () => Effect.succeed(all.map(provider)),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed(all),
          get: (instanceId) =>
            Effect.succeed({
              instanceId,
            } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedNone,
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ServerSettings.layerTest(),
    );
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(dependencies),
    );
    return { dispatched, layer };
  });

const delegate = (
  specs: Record<string, ThreadSpec>,
  calls: ReadonlyArray<{
    readonly thread: ThreadId;
    readonly to: Lead;
    readonly planRef?: string;
    readonly id: string;
  }>,
  policy = enforcing,
  registry: ReadonlyArray<DelegationAuthorization.RegistryPlan> = [],
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const { dispatched, layer } = yield* harness(specs, policy, registry);
    const outcomes = yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* Effect.forEach(
        calls,
        (call) =>
          service
            .delegateTask(scopeFor(call.thread, specs[call.thread]?.lead ?? "codex"), {
              task: "Write hello.txt",
              target: { providerInstanceId: instances[call.to], model: "m1" },
              mode: "async",
              clientRequestId: call.id,
              ...(call.planRef === undefined ? {} : { planRef: call.planRef }),
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(layer));
    return { outcomes, dispatched: yield* Ref.get(dispatched) };
  });

const denied = (outcome: { _tag: string; failure?: unknown }, reason?: string) => {
  assert.equal(outcome._tag, "Failure");
  const failure = outcome.failure as { code: string; message: string };
  assert.equal(failure.code, "capability_denied");
  if (reason !== undefined) assert.include(failure.message, reason);
};

const planA = planItem({
  planId: "rt-aaa",
  lead: "antigravity",
  assignments: [{ id: "hello", provider: "codex" }],
});

describe("server-side delegate_task authorization", () => {
  it.effect("denies cross-provider delegation without a plan", () =>
    Effect.gen(function* () {
      const { outcomes, dispatched } = yield* delegate(
        { [threadA]: { lead: "antigravity", items: [] } },
        [{ thread: threadA, to: "codex", id: "r1" }],
      );
      denied(outcomes[0] as never, "plan_ref_missing");
      assert.deepEqual(dispatched, []);
    }),
  );

  it.effect("allows a plan recorded in the caller's thread and hands the task off", () =>
    Effect.gen(function* () {
      const { outcomes, dispatched } = yield* delegate(
        { [threadA]: { lead: "antigravity", items: [planA] } },
        [{ thread: threadA, to: "codex", planRef: "rt-aaa:hello", id: "r1" }],
      );
      assert.equal(outcomes[0]?._tag, "Success");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.instanceId, "codex");
      assert.equal(dispatched[0]?.parentThreadId, threadA);
      assert.include(dispatched[0]?.task ?? "", "Write hello.txt");
    }),
  );

  it.effect("denies thread B using thread A's plan before A has used it, and A still can", () =>
    Effect.gen(function* () {
      const { outcomes, dispatched } = yield* delegate(
        {
          [threadA]: { lead: "antigravity", items: [planA] },
          [threadB]: { lead: "antigravity", items: [] },
        },
        [
          { thread: threadB, to: "codex", planRef: "rt-aaa:hello", id: "b1" },
          { thread: threadA, to: "codex", planRef: "rt-aaa:hello", id: "a1" },
        ],
      );
      denied(outcomes[0] as never, "plan_not_owned_by_thread");
      assert.equal(outcomes[1]?._tag, "Success");
      assert.deepEqual(
        dispatched.map((entry) => entry.parentThreadId),
        [threadA],
      );
    }),
  );

  it.effect("keeps two concurrent threads isolated, each on its own plan", () =>
    Effect.gen(function* () {
      const planB = planItem({
        planId: "rt-bbb",
        lead: "claude",
        assignments: [{ id: "review", provider: "codex" }],
      });
      const { outcomes, dispatched } = yield* delegate(
        {
          [threadA]: { lead: "antigravity", items: [planA] },
          [threadB]: { lead: "claude", items: [planB] },
        },
        [
          { thread: threadA, to: "codex", planRef: "rt-aaa:hello", id: "a1" },
          { thread: threadB, to: "codex", planRef: "rt-bbb:review", id: "b1" },
          { thread: threadB, to: "codex", planRef: "rt-aaa:hello", id: "b2" },
          { thread: threadA, to: "codex", planRef: "rt-bbb:review", id: "a2" },
        ],
      );
      assert.deepEqual(
        outcomes.map((outcome) => outcome._tag),
        ["Success", "Success", "Failure", "Failure"],
      );
      assert.equal(dispatched.length, 2);
    }),
  );

  it.effect.each([
    {
      name: "an expired plan",
      item: planItem({
        planId: "rt-aaa",
        lead: "antigravity",
        assignments: [{ id: "hello", provider: "codex" }],
        ageMinutes: 90,
      }),
      ref: "rt-aaa:hello",
      to: "codex" as Lead,
      reason: "plan_expired",
    },
    {
      name: "the wrong provider",
      item: planA,
      ref: "rt-aaa:hello",
      to: "claude" as Lead,
      reason: "provider_mismatch",
    },
    {
      name: "the wrong subtask",
      item: planA,
      ref: "rt-aaa:other",
      to: "codex" as Lead,
      reason: "subtask_mismatch",
    },
    {
      name: "an unknown plan",
      item: planA,
      ref: "rt-zzz:hello",
      to: "codex" as Lead,
      reason: "plan_not_owned_by_thread",
    },
    {
      name: "a plan from a lookalike tool",
      item: planItem({
        planId: "rt-aaa",
        lead: "antigravity",
        assignments: [{ id: "hello", provider: "codex" }],
        toolName: "other.plan_work",
      }),
      ref: "rt-aaa:hello",
      to: "codex" as Lead,
      reason: "plan_not_owned_by_thread",
    },
    {
      name: "a plan made by a different lead",
      item: planItem({
        planId: "rt-aaa",
        lead: "codex",
        assignments: [{ id: "hello", provider: "claude" }],
      }),
      ref: "rt-aaa:hello",
      to: "claude" as Lead,
      reason: "lead_mismatch",
    },
  ])("denies $name", ({ item, ref, to, reason }) =>
    Effect.gen(function* () {
      const { outcomes, dispatched } = yield* delegate(
        { [threadA]: { lead: "antigravity", items: [item] } },
        [{ thread: threadA, to, planRef: ref, id: "r1" }],
      );
      denied(outcomes[0] as never, reason);
      assert.deepEqual(dispatched, []);
    }),
  );

  it.effect("denies a caller without a thread identity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { dispatched, layer } = yield* harness({});
      const outcome = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .delegateTask(
            { ...scopeFor(threadA, "antigravity"), thread: undefined },
            {
              task: "x",
              target: { providerInstanceId: instances.codex, model: "m1" },
              planRef: "rt-aaa:hello",
            },
          )
          .pipe(Effect.result);
      }).pipe(Effect.provide(layer));
      assert.equal(outcome._tag, "Failure");
      assert.deepEqual(yield* Ref.get(dispatched), []);
      const decision = DelegationAuthorization.decideDelegation(
        enforcing,
        {
          callerThreadId: undefined,
          callerInstanceId: "antigravity",
          targetInstanceId: "codex",
          planRef: "rt-aaa:hello",
        },
        [planA as never],
        NOW,
      );
      assert.equal(decision.reason, "identity_missing");
    }),
  );

  it.effect.each(["claude", "codex", "antigravity"] as const)(
    "a %s lead delegates to each other provider through the same policy",
    (lead) =>
      Effect.gen(function* () {
        const targets = (Object.keys(instances) as Lead[]).filter((name) => name !== lead);
        const item = planItem({
          planId: "rt-multi",
          lead,
          assignments: targets.map((name) => ({ id: name, provider: name })),
        });
        const { outcomes } = yield* delegate(
          { [threadA]: { lead, items: [item] } },
          targets.map((name) => ({
            thread: threadA,
            to: name,
            planRef: `rt-multi:${name}`,
            id: `r-${name}`,
          })),
        );
        assert.deepEqual(
          outcomes.map((outcome) => outcome._tag),
          targets.map(() => "Success"),
        );
      }),
  );

  it.effect("leaves native same-provider delegation and non-enforcing installs unchanged", () =>
    Effect.gen(function* () {
      const same = yield* delegate({ [threadA]: { lead: "codex", items: [] } }, [
        { thread: threadA, to: "codex", id: "r1" },
      ]);
      assert.equal(same.outcomes[0]?._tag, "Success");
      const off = yield* delegate(
        { [threadA]: { lead: "codex", items: [] } },
        [{ thread: threadA, to: "claude", id: "r2" }],
        { ...enforcing, enforce: false, source: "default" },
      );
      assert.equal(off.outcomes[0]?._tag, "Success");
    }),
  );
});

const vectorGoal = 'Buat hello — ünï "q"';
const vectorSubtasks = [
  { id: "hello", role: "implementation", est_loc: 5, files: ["a.txt"], task: "T\nline" },
];
const agRegistry: DelegationAuthorization.RegistryPlan[] = [
  {
    plan_id: "rt-ag",
    ts: (NOW - MINUTE - 1000) / 1000,
    input_digest: "0679be48d1d7914301f43d2ef1da98fc394b478e4c967c414bb7d55940cb65ec",
    decision: "DELEGATE",
    lead_provider: "antigravity",
    assignments: [{ id: "hello", provider: "codex", decision: "DELEGATE" }],
  },
];
// Antigravity records only a call summary for MCP tools: no plan JSON in the output.
const agCall = (
  title: string,
  goal = vectorGoal,
  subtasks: unknown = vectorSubtasks,
  shiftMs = 0,
) => ({
  type: "dynamic_tool",
  status: "completed",
  toolName: "Tool",
  title,
  startedAt: DateTime.makeUnsafe(NOW - MINUTE - 2000 + shiftMs),
  completedAt: DateTime.makeUnsafe(NOW - MINUTE + shiftMs),
  input: { arguments: { goal, lead_provider: "antigravity", subtasks } },
  output: title,
});

describe("plan proof for providers that record only a call summary", () => {
  it.effect("matches the router digest vector", () =>
    Effect.sync(() => {
      assert.equal(
        DelegationAuthorization.planInputDigest({
          arguments: { goal: vectorGoal, lead_provider: "antigravity", subtasks: vectorSubtasks },
        }),
        "0679be48d1d7914301f43d2ef1da98fc394b478e4c967c414bb7d55940cb65ec",
      );
      assert.equal(
        DelegationAuthorization.planInputDigest({ goal: vectorGoal, subtasks: vectorSubtasks }),
        "7a74b7d249f7367e2ff8bcbc4c5e78aeac3d6a8b71996fba84626b1d43e6e88c",
      );
    }),
  );

  it.effect("allows the thread that sent the arguments and denies every other thread", () =>
    Effect.gen(function* () {
      const { outcomes, dispatched } = yield* delegate(
        {
          [threadA]: { lead: "antigravity", items: [agCall("Plan single subtask work")] },
          [threadB]: { lead: "antigravity", items: [] },
        },
        [
          { thread: threadB, to: "codex", planRef: "rt-ag:hello", id: "b1" },
          { thread: threadA, to: "codex", planRef: "rt-ag:hello", id: "a1" },
        ],
        enforcing,
        agRegistry,
      );
      denied(outcomes[0] as never, "plan_not_owned_by_thread");
      assert.equal(outcomes[1]?._tag, "Success");
      assert.deepEqual(
        dispatched.map((entry) => entry.parentThreadId),
        [threadA],
      );
    }),
  );

  it.effect("denies a copied call made at another time, or different arguments", () =>
    Effect.gen(function* () {
      const { outcomes } = yield* delegate(
        {
          [threadA]: {
            lead: "antigravity",
            items: [agCall("Quota status check", vectorGoal, vectorSubtasks, 10 * MINUTE)],
          },
          [threadB]: {
            lead: "antigravity",
            items: [agCall("Call plan_work", vectorGoal, [{ ...vectorSubtasks[0], est_loc: 6 }])],
          },
        },
        [
          { thread: threadA, to: "codex", planRef: "rt-ag:hello", id: "a1" },
          { thread: threadB, to: "codex", planRef: "rt-ag:hello", id: "b1" },
        ],
        enforcing,
        agRegistry,
      );
      denied(outcomes[0] as never, "plan_not_owned_by_thread");
      denied(outcomes[1] as never, "plan_not_owned_by_thread");
    }),
  );
});

describe("delegation policy activation", () => {
  it.effect("reads the policy file in the server state dir and never fails open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, DelegationAuthorization.DELEGATION_POLICY_FILE);
      const none = DelegationAuthorization.loadDelegationPolicy(dir, {});
      assert.deepEqual([none.enforce, none.source], [false, "default"]);
      assert.isTrue(
        DelegationAuthorization.loadDelegationPolicy(dir, { T3CODE_DELEGATION_ENFORCE: "1" })
          .enforce,
      );
      yield* fs.writeFileString(file, JSON.stringify({ enforce: true, planTtlMinutes: 5 }));
      const on = DelegationAuthorization.loadDelegationPolicy(dir, {});
      assert.deepEqual([on.enforce, on.planTtlMs, on.source], [true, 5 * MINUTE, "file"]);
      yield* fs.writeFileString(file, JSON.stringify({ enforce: false }));
      assert.isFalse(DelegationAuthorization.loadDelegationPolicy(dir, {}).enforce);
      yield* fs.writeFileString(file, "{ not json");
      const broken = DelegationAuthorization.loadDelegationPolicy(dir, {});
      assert.deepEqual([broken.enforce, broken.source], [true, "invalid"]);
      assert.equal(
        DelegationAuthorization.decideDelegation(
          broken,
          { callerThreadId: "t", callerInstanceId: "a", targetInstanceId: "b", planRef: "p:x" },
          [],
          NOW,
        ).reason,
        "policy_invalid",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
