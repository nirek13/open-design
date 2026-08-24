// In-app search accelerator. Command+Space is Spotlight on macOS and
// Command+1 is first-tab in Chromium, so the focused window must claim
// both before the OS / shell does. The renderer still listens in the browser.

export const TOGGLE_SEARCH_IPC_CHANNEL = "od:toggle-search";

function isToggleSearchKey(key: string, code: string | undefined): boolean {
  if (key === " " || key === "Spacebar" || code === "Space") return true;
  return key === "1" || code === "Digit1";
}

export function isToggleSearchInput(
  input: {
    type: string;
    key: string;
    code?: string;
    meta: boolean;
    control: boolean;
    alt: boolean;
    shift: boolean;
  },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type !== "keyDown") return false;
  if (input.alt || input.shift) return false;
  if (!isToggleSearchKey(input.key, input.code)) return false;
  if (platform === "darwin") return input.meta && !input.control;
  return input.control && !input.meta;
}
