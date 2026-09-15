/**
 * Update popups for the mobile app (2.0.0 and newer), served by
 * GET /api/app/version. The server only reports versions; the app decides
 * what to show. Both values are optional and read once at startup:
 * - LATEST_APP_VERSION: normal update. Older apps show a "New version
 *   available" popup that can be closed.
 * - MIN_APP_VERSION: hard update, for critical releases. Older apps show an
 *   "Update required" popup that cannot be closed.
 *
 * Set either one only once that version is live on the Play Store, or users
 * are asked to install something they cannot download yet.
 */

export const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.melager.mobile";

const readVersionEnv = (name: string): string | null => {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  // The app only understands major.minor.patch; anything else would silently
  // disable the popup, so fail at boot instead.
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`${name} must look like 2.0.0, got "${raw}"`);
  }
  return raw;
};

export const MIN_APP_VERSION = readVersionEnv("MIN_APP_VERSION");
export const LATEST_APP_VERSION = readVersionEnv("LATEST_APP_VERSION");
