// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";

const original = process.env.T3CODE_SESSION_RULES_DIR;
const originalHome = process.env.HOME;
afterEach(() => {
  if (original === undefined) delete process.env.T3CODE_SESSION_RULES_DIR;
  else process.env.T3CODE_SESSION_RULES_DIR = original;
  process.env.HOME = originalHome;
});

describe("Codex T3 session overlay", () => {
  it("adds capped, keyed overlay entries once and nothing when the file is absent", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cx-overlay-"));
    process.env.HOME = dir; // keep evidence log out of the real home
    process.env.T3CODE_SESSION_RULES_DIR = dir;
    const runtime = { model: "gpt-x" };
    expect(
      Object.keys(buildCodexAdditionalContext(runtime, false)).some((k) => k.includes("overlay")),
    ).toBe(false);

    NodeFS.writeFileSync(
      NodePath.join(dir, "codex.md"),
      Array.from({ length: 200 }, (_, i) => `aturan t3 ${i} CANARY-TEST`).join("\n"),
    );
    const ctx = buildCodexAdditionalContext(runtime, false, "thread-1");
    const keys = Object.keys(ctx).filter((k) => k.startsWith("t3_code_overlay_"));
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys) {
      const v = (ctx[k] as { value: string }).value;
      expect(Buffer.byteLength(v, "utf8")).toBeLessThanOrEqual(4000);
    }
    const joined = keys.map((k) => (ctx[k] as { value: string }).value).join("\n");
    expect(joined.match(/aturan t3 0 CANARY-TEST/g)?.length).toBe(1);
    const log = NodeFS.readFileSync(
      NodePath.join(dir, ".t3/userdata/logs/session-overlay.ndjson"),
      "utf8",
    );
    expect(log).toContain('"provider":"codex"');
    expect(log).not.toContain("CANARY-TEST");
  });
});
