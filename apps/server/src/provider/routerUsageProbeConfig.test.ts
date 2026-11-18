// Author / Agent: Codex
import { describe, it, expect } from "vite-plus/test";
import { selectRouterProbeInstance as select } from "./routerUsageProbeConfig.ts";
import { routerProbeEnvironment } from "./routerUsageProbeConfig.ts";

it("excludes inherited shell account and gateway overrides from the usage probe", () => {
  expect(
    routerProbeEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "fixture",
      CLAUDE_CONFIG_DIR: "/other-account",
      ANTHROPIC_BASE_URL: "https://fixture.invalid",
      NODE_OPTIONS: "fixture",
      T3_SECRET: "fixture",
    }),
  ).toEqual({ PATH: "/bin", HOME: "/home/test" });
});

describe("router native account selection", () => {
  it("drops ambient account and gateway overrides without mutating the caller", () => {
    const source = {
      PATH: "/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "fixture",
      CLAUDE_CONFIG_DIR: "/other-account",
      ANTHROPIC_BASE_URL: "https://fixture.invalid",
      NODE_OPTIONS: "fixture",
    };
    expect(routerProbeEnvironment(source)).toEqual({ PATH: "/bin", HOME: "/home/test" });
    expect(source.CLAUDE_CONFIG_DIR).toBe("/other-account");
  });
  it("keeps the configured account and binary; never chooses another instance", () => {
    const config = { binaryPath: "/configured/codex", homePath: "/configured/home" };
    expect(select({ providerInstances: { custom: { driver: "codex", config } } }, "codex")).toEqual(
      { id: "custom", config },
    );
    expect(
      select({ providerInstances: { a: { driver: "codex" }, b: { driver: "codex" } } }, "codex"),
    ).toBeUndefined();
  });
  it("rejects disabled, malformed and unsupported environment selections", () => {
    for (const selected of [
      { enabled: false },
      { environment: [{ name: "KEY", value: "fixture" }] },
      { environment: "invalid" },
      { config: null },
      { config: "invalid" },
    ]) {
      const value = { driver: "codex", ...selected };
      expect(select({ providerInstances: { codex: value } }, "codex")).toBeUndefined();
    }
    for (const settings of [
      null,
      [],
      "invalid",
      { providerInstances: [] },
      { providerInstances: { codex: null } },
    ])
      expect(select(settings, "codex")).toBeUndefined();
  });
  it("uses builtin defaults only when no instance is configured", () => {
    expect(select({}, "codex")).toEqual({ id: "codex", config: {} });
  });
});
