export const ATTACHMENT_TENANT_ID = "refalco";
export const ATTACHMENT_BUCKET = "rafa-private-attachments";
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MIME_TYPES = Object.freeze([
  "image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain", "text/csv",
  "text/tab-separated-values", "text/markdown", "application/json", "application/xml", "text/xml"
]);

export function validateAttachmentMetadata(body = {}) {
  const userId = String(body.userId || "").trim();
  const messageId = String(body.messageId || "").trim();
  const fileName = String(body.fileName || "").replace(/[\\/\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
  const contentType = String(body.contentType || "").toLowerCase();
  const sizeBytes = Number(body.sizeBytes);
  const sha256 = String(body.sha256 || "").toLowerCase();
  if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(userId)
      || !messageId || messageId.length > 200 || !fileName
      || !ATTACHMENT_MIME_TYPES.includes(contentType) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_SIZE_BYTES
      || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw Object.assign(new Error("Invalid attachment metadata."), { code: "INVALID_ATTACHMENT_METADATA" });
  }
  return { userId, messageId, fileName, contentType, sizeBytes, sha256 };
}

export function attachmentStoragePath(contactId, messageHash, attachmentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(contactId || "")) || !/^[0-9a-f]{64}$/i.test(String(messageHash || ""))
      || !/^[0-9a-f-]{36}$/i.test(String(attachmentId || ""))) {
    throw Object.assign(new Error("Invalid attachment storage identity."), { code: "INVALID_ATTACHMENT_IDENTITY" });
  }
  return `${ATTACHMENT_TENANT_ID}/${contactId}/${messageHash}/${attachmentId}`;
}

export function attachmentBelongsToContact(row, { tenantId = ATTACHMENT_TENANT_ID, contactId, messageId, attachmentId } = {}) {
  return Boolean(row && row.tenant_id === ATTACHMENT_TENANT_ID && tenantId === ATTACHMENT_TENANT_ID
    && row.contact_id === contactId && row.provider_message_id === messageId && row.id === attachmentId);
}

export function isValidFailedAttachmentReference(attachment) {
  return Boolean(attachment && typeof attachment === "object" && attachment.status === "failed"
    && typeof attachment.messageId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(attachment.messageId)
    && typeof attachment.reasonCode === "string" && /^[A-Z0-9_]{1,60}$/.test(attachment.reasonCode));
}

export function isPrivateAttachmentBucket(bucket) {
  return Boolean(bucket && bucket.public === false
    && Number(bucket.file_size_limit) === MAX_ATTACHMENT_SIZE_BYTES
    && Array.isArray(bucket.allowed_mime_types)
    && ATTACHMENT_MIME_TYPES.every((mime) => bucket.allowed_mime_types.includes(mime)));
}
