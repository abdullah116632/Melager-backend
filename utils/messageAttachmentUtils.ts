import {
  MESSAGE_ATTACHMENT_KINDS,
  type MessageAttachment,
  type MessageAttachmentKind,
} from "../db/dbConfig.js";

/**
 * Largest file a member may send, however it travels. Enforced when a file
 * is counted (controllers/messageFileController.ts), so an oversized file
 * gets a clear 413 rather than a malformed-description error.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const KIND_LABELS: Record<MessageAttachmentKind, string> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  file: "File",
};

const optionalDimension = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Validates the attachment a client describes. Returns null when the message
 * carries none and undefined when the description is malformed, which the
 * caller reports as a bad request.
 */
export const parseMessageAttachment = (
  raw: unknown,
): MessageAttachment | null | undefined => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;

  const id = String(value.id ?? "").toLowerCase();
  const kind = value.kind as MessageAttachmentKind;
  // Path separators are stripped because receivers use the name on disk.
  const name = String(value.name ?? "")
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 200);
  const mimeType = String(value.mimeType ?? "")
    .trim()
    .slice(0, 150);
  const size = Number(value.size);
  const sha256 = String(value.sha256 ?? "").toLowerCase();
  const width = optionalDimension(value.width);
  const height = optionalDimension(value.height);
  const durationMs = optionalDimension(value.durationMs);

  if (
    !UUID_PATTERN.test(id) ||
    !MESSAGE_ATTACHMENT_KINDS.includes(kind) ||
    !name ||
    !mimeType ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !SHA256_PATTERN.test(sha256) ||
    width === undefined ||
    height === undefined ||
    durationMs === undefined
  ) {
    return undefined;
  }
  return { id, kind, name, mimeType, size, sha256, width, height, durationMs };
};

/**
 * The text stored as the body of a file message. Older app builds only know
 * about the body, so this is what they show, and it is also what push
 * notifications and reply quotes display.
 */
export const attachmentFallbackBody = (attachment: MessageAttachment): string =>
  `📎 ${KIND_LABELS[attachment.kind]} · ${attachment.name}`;
