// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { chunkByBytes, readSessionOverlay } from "./sessionOverlay.ts";

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "overlay-"));

describe("sessionOverlay", () => {
  it("returns null when the file is missing or empty", () => {
    const dir = tmp();
    const env = { T3CODE_SESSION_RULES_DIR: dir } as NodeJS.ProcessEnv;
    expect(readSessionOverlay("codex", env)).toBeNull();
    NodeFS.writeFileSync(NodePath.join(dir, "codex.md"), "  \n");
    expect(readSessionOverlay("codex", env)).toBeNull();
  });

  it("reads per-provider files with a stable hash", () => {
    const dir = tmp();
    const env = { T3CODE_SESSION_RULES_DIR: dir } as NodeJS.ProcessEnv;
    NodeFS.writeFileSync(NodePath.join(dir, "codex.md"), "aturan\n");
    NodeFS.writeFileSync(NodePath.join(dir, "claude.md"), "lain\n");
    const a = readSessionOverlay("codex", env);
    expect(a?.text).toBe("aturan");
    expect(a?.sha256).toBe(readSessionOverlay("codex", env)?.sha256);
    expect(a?.sha256).not.toBe(readSessionOverlay("claude", env)?.sha256);
  });

  it("chunks within the byte cap and round-trips", () => {
    const text = Array.from({ length: 300 }, (_, i) => `baris ${i} — ünï`).join("\n");
    const chunks = chunkByBytes(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(4000);
    expect(chunks.join("\n")).toBe(text);
  });
});
