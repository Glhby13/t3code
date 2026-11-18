// Author / Agent: Codex
// Read-only selection for the external router probe. Ambiguous accounts fail closed.
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keep process basics, never inherit shell-specific account, gateway or SDK overrides.
export function routerProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export function selectRouterProbeInstance(settings: unknown, driver: string) {
  if (!record(settings)) return undefined;
  const instances = settings.providerInstances;
  if (instances !== undefined && !record(instances)) return undefined;
  if (
    Object.values(instances ?? {}).some(
      (value) => !record(value) || typeof value.driver !== "string",
    )
  )
    return undefined;
  const matches = Object.entries(instances ?? {}).filter(
    ([, value]) => record(value) && value.driver === driver,
  );
  if (matches.length > 1) return undefined;
  const [id, selected] = matches[0] ?? [driver, {}];
  if (!record(selected) || selected.enabled === false) return undefined;
  if (
    selected.environment !== undefined &&
    (!Array.isArray(selected.environment) || selected.environment.length > 0)
  )
    return undefined;
  const config = selected.config === undefined ? {} : selected.config;
  if (!record(config)) return undefined;
  return { id, config };
}
