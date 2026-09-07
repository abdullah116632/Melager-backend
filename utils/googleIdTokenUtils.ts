import { OAuth2Client } from "google-auth-library";

import { getConfiguredGoogleClientIds } from "./authUtils.js";

const googleClient = new OAuth2Client();

export class GoogleIdTokenError extends Error {
  status: 401 | 503;

  constructor(message: string, status: 401 | 503) {
    super(message);
    this.status = status;
  }
}

export interface VerifiedGoogleIdToken {
  subject: string;
  email: string;
  name: string | null;
}

// Verifies a Google ID token server-side. Used both to sign a user in (where
// the email/name identify or create the account) and, for accounts that have
// no usable password (Google-only sign-up), to re-prove identity before a
// destructive action by comparing `subject` against the stored googleSubject.
export const verifyGoogleIdToken = async (
  idToken: string,
): Promise<VerifiedGoogleIdToken> => {
  const audiences = getConfiguredGoogleClientIds();
  if (audiences.length === 0) {
    throw new GoogleIdTokenError(
      "Google sign-in is not configured yet",
      503,
    );
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new GoogleIdTokenError(
        "Your Google account email could not be verified",
        401,
      );
    }
    return {
      subject: payload.sub,
      email: payload.email,
      name: payload.name?.trim() || null,
    };
  } catch (err) {
    if (err instanceof GoogleIdTokenError) throw err;
    throw new GoogleIdTokenError("Google sign-in could not be verified", 401);
  }
};
