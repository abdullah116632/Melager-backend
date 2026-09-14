/**
 * The single source for the JWT signing key, resolved once at startup.
 *
 * This used to be read inline in two places, each with a
 * `?? "dev-secret-please-set-session-secret"` fallback. That is the dangerous
 * shape for a signing key: a deploy that simply forgot the variable kept
 * serving traffic, signing every session with a string that is public in the
 * source and in dist/index.mjs, so anyone could mint a token for any userId —
 * including a mess admin. Refusing to boot is the safe failure here, matching
 * how DATABASE_URL (db/dbConfig.ts) and PORT (index.ts) are already handled.
 *
 * Having one exported constant also keeps the REST middleware and the Socket.IO
 * handshake on the same key by construction; when they each read the variable
 * themselves, fixing only one of them left sockets silently rejecting tokens
 * the REST API accepted.
 */

const MIN_SESSION_SECRET_LENGTH = 32;

/** The former fallback, rejected outright in case it is ever pasted into .env. */
const KNOWN_INSECURE_SECRET = "dev-secret-please-set-session-secret";

const GENERATE_HINT =
  "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"";

const readSessionSecret = (): string => {
  // Deliberately not trimmed. The value is compared byte for byte against what
  // already-issued tokens were signed with, so normalizing it here would
  // invalidate every live session on a deploy if the configured value happens
  // to carry surrounding whitespace.
  const secret = process.env["SESSION_SECRET"];

  if (!secret) {
    throw new Error(
      `SESSION_SECRET environment variable is required but was not provided. ${GENERATE_HINT}`,
    );
  }
  if (secret === KNOWN_INSECURE_SECRET) {
    throw new Error(
      `SESSION_SECRET is set to the placeholder value, which is public. ${GENERATE_HINT}`,
    );
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; ` +
        `the configured value is ${secret.length}. ${GENERATE_HINT}`,
    );
  }

  return secret;
};

export const SESSION_SECRET: string = readSessionSecret();
