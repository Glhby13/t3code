import type {
  ClientSettings,
  SidebarHeaderAnimation,
  SidebarHeaderStyle,
} from "@t3tools/contracts/settings";
import designLabPalettes from "./sidebarDesignPalettes.json";

export const SIDEBAR_PALETTES = designLabPalettes;

function readLegacySidebarPreset(themeId: string | null | undefined) {
  const match =
    /^cp77-(.+)-(hud|chamfer)-(none|cursor-blink|hazard-scroll|dual-rail|hard-scan)$/.exec(
      themeId ?? "",
    );
  if (match === null) return null;
  const palette = SIDEBAR_PALETTES.find(({ id }) => id === `cp77-${match[1]}`);
  if (!palette) return null;
  return {
    paletteId: palette.id,
    style: match[2] as SidebarHeaderStyle,
    animation: match[3] as SidebarHeaderAnimation,
  };
}

export function sidebarPaletteId(themeId: string): string {
  return readLegacySidebarPreset(themeId)?.paletteId ?? themeId;
}

export function isSidebarPalette(themeId: string): boolean {
  const paletteId = sidebarPaletteId(themeId);
  return SIDEBAR_PALETTES.some(({ id }) => id === paletteId);
}

export function hydrateSidebarDecoration(
  settings: ClientSettings,
  themeId: string | null | undefined,
): ClientSettings {
  const preset = readLegacySidebarPreset(themeId);
  if (
    preset === null ||
    (settings.sidebarHeaderStyle !== null && settings.sidebarHeaderAnimation !== null)
  ) {
    return settings;
  }
  return {
    ...settings,
    sidebarHeaderStyle: settings.sidebarHeaderStyle ?? preset.style,
    sidebarHeaderAnimation: settings.sidebarHeaderAnimation ?? preset.animation,
  };
}
