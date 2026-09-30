import { createHash, createHmac } from "node:crypto";

/**
 * Minimal Cloudflare R2 client (S3 API, AWS Signature V4) for chat files.
 * Only the few calls the chat needs are implemented, so the backend does not
 * pull in the whole AWS SDK. The credentials never leave this server: phones
 * get short-lived presigned URLs instead.
 */

const REGION = "auto";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  host: string;
}

const readConfig = (): R2Config | null => {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;
  // A bucket path pasted along with the endpoint is ignored; only the host counts.
  const host = new URL(endpoint).host;
  return { accountId, accessKeyId, secretAccessKey, bucket, host };
};

const config = readConfig();

/** False when the R2 variables are missing, so chat files stay phone to phone. */
export const isR2Configured = config !== null;

/** Days a shared file stays in R2. Must match the bucket's lifecycle rule. */
export const R2_FILE_RETENTION_DAYS = (() => {
  const days = Number(process.env.R2_FILE_RETENTION_DAYS ?? 3);
  return Number.isInteger(days) && days > 0 ? days : 3;
})();

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const objectPath = (bucket: string, key: string) =>
  `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;

const timestamps = (now: Date) => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

const signingKey = (secret: string, dateStamp: string) =>
  hmac(
    hmac(hmac(hmac(`AWS4${secret}`, dateStamp), REGION), SERVICE),
    "aws4_request",
  );

const sign = (
  cfg: R2Config,
  input: {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    amzDate: string;
    dateStamp: string;
  },
) => {
  const headerNames = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [
      name.toLowerCase(),
      value.trim(),
    ]),
  );
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(input.query[key]!)}`)
    .join("&");
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${lowered[name]}\n`)
    .join("");
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const scope = `${input.dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(cfg.secretAccessKey, input.dateStamp),
  )
    .update(stringToSign)
    .digest("hex");
  return { signature, signedHeaders, scope, canonicalQuery };
};

const requireConfig = (): R2Config => {
  if (!config) throw new Error("R2 storage is not configured");
  return config;
};

/**
 * A URL that lets its holder run one request on one object until it expires.
 * `headers` are signed too, so the client must send exactly those values:
 * signing Content-Length is what stops an upload from exceeding its reserved
 * size.
 */
export const presignR2Url = (input: {
  method: "GET" | "PUT";
  key: string;
  expiresInSeconds: number;
  headers?: Record<string, string>;
}): string => {
  const cfg = requireConfig();
  const { amzDate, dateStamp } = timestamps(new Date());
  const headers = { host: cfg.host, ...(input.headers ?? {}) };
  const path = objectPath(cfg.bucket, input.key);
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresInSeconds),
    "X-Amz-SignedHeaders": Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort()
      .join(";"),
  };
  const { signature, canonicalQuery } = sign(cfg, {
    method: input.method,
    path,
    query,
    headers,
    amzDate,
    dateStamp,
  });
  return `https://${cfg.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

const signedFetch = async (method: "HEAD" | "DELETE", key: string) => {
  const cfg = requireConfig();
  const { amzDate, dateStamp } = timestamps(new Date());
  const path = objectPath(cfg.bucket, key);
  const headers = {
    host: cfg.host,
    "x-amz-content-sha256": UNSIGNED_PAYLOAD,
    "x-amz-date": amzDate,
  };
  const { signature, signedHeaders, scope } = sign(cfg, {
    method,
    path,
    query: {},
    headers,
    amzDate,
    dateStamp,
  });
  return fetch(`https://${cfg.host}${path}`, {
    method,
    headers: {
      "x-amz-content-sha256": UNSIGNED_PAYLOAD,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
};

/** Size of a stored object, or null when it is not there. */
export const headR2Object = async (key: string): Promise<number | null> => {
  const response = await signedFetch("HEAD", key);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 HEAD failed (${response.status})`);
  return Number(response.headers.get("content-length"));
};

export const deleteR2Object = async (key: string): Promise<void> => {
  const response = await signedFetch("DELETE", key);
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 DELETE failed (${response.status})`);
  }
};
