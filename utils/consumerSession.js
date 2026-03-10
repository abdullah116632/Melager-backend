import jwt from 'jsonwebtoken';

export const CONSUMER_SESSION_COOKIE = 'consumer_session';

const getSessionSecret = () => process.env.CONSUMER_SESSION_SECRET || process.env.JWT_SECRET;

const parseCookies = (cookieHeader = '') => {
  const cookies = {};

  cookieHeader.split(';').forEach((part) => {
    const [rawKey, ...rawValueParts] = part.split('=');

    if (!rawKey) {
      return;
    }

    const key = rawKey.trim();
    const value = rawValueParts.join('=').trim();

    if (!key || !value) {
      return;
    }

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
};

export const getConsumerSessionFromRequest = (req) => {
  const cookieHeader = req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  const cookies = parseCookies(cookieHeader);
  const token = cookies[CONSUMER_SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const secret = getSessionSecret();

  if (!secret) {
    return null;
  }

  try {
    const payload = jwt.verify(token, secret);

    if (!payload?.sessionId) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      token,
    };
  } catch (error) {
    return null;
  }
};

export const setConsumerSessionCookie = (res, sessionId) => {
  const secret = getSessionSecret();

  if (!secret) {
    throw new Error('CONSUMER_SESSION_SECRET or JWT_SECRET must be configured');
  }

  const maxAgeMs = Number(process.env.CONSUMER_SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 24 * 180);
  const rawSameSite = (process.env.CONSUMER_SESSION_SAMESITE || 'lax').toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(rawSameSite) ? rawSameSite : 'lax';
  const secure = sameSite === 'none' ? true : process.env.NODE_ENV === 'production';

  const token = jwt.sign({ sessionId }, secret, { expiresIn: '180d' });

  res.cookie(CONSUMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: maxAgeMs,
    path: '/',
  });
};
