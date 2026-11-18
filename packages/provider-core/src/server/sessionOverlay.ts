// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synchronous, best-effort file read and evidence line keep turn construction non-async.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** T3-only session rules live outside native provider config: ~/.t3/session-rules/<provider>.md. */
const T3_SESSION_RULES_DIR_ENV = "T3CODE_SESSION_RULES_DIR";

export interface SessionOverlay {
  readonly provider: string;
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
}

const rulesDir = (env: NodeJS.ProcessEnv): string =>
  env[T3_SESSION_RULES_DIR_ENV]?.trim() ||
  NodePath.join(env.HOME || NodeOS.homedir(), ".t3", "session-rules");

/** Returns null when the overlay is absent or empty, so a missing file never breaks a session. */
export function readSessionOverlay(
  provider: "claude" | "codex" | "antigravity",
  env: NodeJS.ProcessEnv = process.env,
): SessionOverlay | null {
  const path = NodePath.join(rulesDir(env), `${provider}.md`);
  try {
    const text = NodeFS.readFileSync(path, "utf8").trim();
    if (text.length === 0) return null;
    return {
      provider,
      path,
      text,
      sha256: NodeCrypto.createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } catch {
    return null;
  }
}

/** Split on line boundaries into chunks of at most maxBytes UTF-8 bytes. */
export function chunkByBytes(text: string, maxBytes: number): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let current = "";
  const push = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };
  for (const rawLine of text.split("\n")) {
    // A single over-long line is cut by code point.
    const pieces: Array<string> = [];
    let line = rawLine;
    while (Buffer.byteLength(line, "utf8") > maxBytes) {
      let cut = line.slice(0, maxBytes);
      while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
      pieces.push(cut);
      line = line.slice(cut.length);
    }
    pieces.push(line);
    for (const piece of pieces) {
      const next = current.length === 0 ? piece : `${current}\n${piece}`;
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        push();
        current = piece;
      } else {
        current = next;
      }
    }
  }
  push();
  return chunks;
}

/** One non-sensitive evidence line per injection. Never logs rule content. */
export function recordSessionOverlayInjection(
  overlay: SessionOverlay,
  details: { readonly source: string; readonly threadId?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const dir = NodePath.join(env.HOME || NodeOS.homedir(), ".t3", "userdata", "logs");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.appendFileSync(
      NodePath.join(dir, "session-overlay.ndjson"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        provider: overlay.provider,
        threadId: details.threadId ?? null,
        source: details.source,
        sha256: overlay.sha256,
        bytes: overlay.bytes,
        injected: true,
      })}\n`,
    );
  } catch {
    // Evidence logging must never fail a turn.
  }
}
