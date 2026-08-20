/**
 * Source of truth for "is a newer Agent Canvas published?".
 *
 * This is a personal fork (starley1234/OpenHands) deployed from source — it is
 * NOT installed from npm or the ghcr.io image, so the upstream npm/ghcr
 * "latest" check is meaningless here. The update card is disabled for this
 * build: the app is rebuilt from the fork's branch instead of updated in place.
 *
 * Kept as a module so the release channel / commands can be pointed at the
 * fork's git repo if the card is ever re-enabled.
 */
export const AGENT_CANVAS_RELEASE_NOTES_URL =
  "https://github.com/starley1234/OpenHands/releases";

/** Literal shell commands — intentionally not localized. */
export const AGENT_CANVAS_UPDATE_COMMANDS = {
  git: "git fetch origin && git reset --hard origin/arena/019fd5d3-openhands && docker compose up -d --build",
} as const;

export async function fetchLatestAgentCanvasVersion(
  _signal?: AbortSignal,
): Promise<string> {
  // The update card is hidden for this fork; keep this a no-op that resolves
  // to the running version so any accidental call never flags a false update.
  return Promise.resolve("0.0.0");
}
