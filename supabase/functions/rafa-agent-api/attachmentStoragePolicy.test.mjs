import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ATTACHMENT_BUCKET, ATTACHMENT_TENANT_ID, ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_SIZE_BYTES,
  attachmentBelongsToContact, attachmentStoragePath, isPrivateAttachmentBucket, isValidFailedAttachmentReference, validateAttachmentMetadata
} from "./attachmentStoragePolicy.mjs";

test("attachment records are fixed to the REFAL tenant and validated contact/message scope", () => {
  const metadata = validateAttachmentMetadata({ userId: "12345@s.whatsapp.net", messageId: "provider-1", fileName: "../invoice.pdf",
    contentType: "application/pdf", sizeBytes: 128, sha256: "a".repeat(64), tenantId: "attacker" });
  assert.equal(metadata.fileName, "..invoice.pdf");
  assert.equal("tenantId" in metadata, false);
  const id = "10000000-0000-4000-8000-000000000001";
  const contactId = "20000000-0000-4000-8000-000000000002";
  const row = { id, tenant_id: ATTACHMENT_TENANT_ID, contact_id: contactId, provider_message_id: "provider-1" };
  assert.equal(attachmentBelongsToContact(row, { contactId, messageId: "provider-1", attachmentId: id }), true);
  assert.equal(attachmentBelongsToContact({ ...row, contact_id: "other-contact" }, { contactId, messageId: "provider-1", attachmentId: id }), false);
  assert.equal(attachmentBelongsToContact({ ...row, tenant_id: "other-tenant" }, { contactId, messageId: "provider-1", attachmentId: id }), false);
  assert.match(attachmentStoragePath(contactId, "c".repeat(64), id), /^refalco\//u);
  assert.throws(() => attachmentStoragePath(contactId, "../bad", id), { code: "INVALID_ATTACHMENT_IDENTITY" });
});

test("attachment uploads fail closed unless the bucket is private and size/MIME constrained", () => {
  const privateBucket = { public: false, file_size_limit: MAX_ATTACHMENT_SIZE_BYTES, allowed_mime_types: [...ATTACHMENT_MIME_TYPES] };
  assert.equal(ATTACHMENT_BUCKET, "rafa-private-attachments");
  assert.equal(isPrivateAttachmentBucket(privateBucket), true);
  assert.equal(isPrivateAttachmentBucket({ ...privateBucket, public: true }), false);
  assert.equal(isPrivateAttachmentBucket({ ...privateBucket, file_size_limit: null }), false);
  assert.equal(isPrivateAttachmentBucket({ ...privateBucket, allowed_mime_types: ["image/png"] }), false);
  assert.throws(() => validateAttachmentMetadata({ userId: "12345@s.whatsapp.net", messageId: "m", fileName: "file.bin",
    contentType: "application/octet-stream", sizeBytes: 10, sha256: "a".repeat(64) }), { code: "INVALID_ATTACHMENT_METADATA" });
  assert.throws(() => validateAttachmentMetadata({ userId: "12345@s.whatsapp.net", messageId: "m", fileName: "file.pdf",
    contentType: "application/pdf", sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1, sha256: "a".repeat(64) }), { code: "INVALID_ATTACHMENT_METADATA" });
});

test("failed attachment history references are accepted only without a storage id and with bounded provider metadata", () => {
  const failed = { status: "failed", messageId: "3EB081A3DDDFC6146BB3D2", reasonCode: "ATTACHMENT_TYPE_MISMATCH" };
  assert.equal(isValidFailedAttachmentReference(failed), true);
  assert.equal(isValidFailedAttachmentReference({ ...failed, status: "uploaded" }), false);
  assert.equal(isValidFailedAttachmentReference({ ...failed, messageId: "bad/id" }), false);
  assert.equal(isValidFailedAttachmentReference({ ...failed, reasonCode: "bad code" }), false);
});

test("migration locks attachment metadata behind service-role-only RLS", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(path.resolve(here, "../../migrations/20261029212200_rafa_private_attachments.sql"), "utf8");
  assert.match(sql, /create table if not exists public\.rafa_attachments/u);
  assert.match(sql, /tenant_id text not null default 'refalco' check \(tenant_id = 'refalco'\)/u);
  assert.match(sql, /contact_id uuid not null references public\.rafa_contacts/u);
  assert.match(sql, /conversation_turn_id uuid references public\.rafa_conversation_turns/u);
  assert.match(sql, /alter table public\.rafa_attachments enable row level security/u);
  assert.match(sql, /revoke all on table public\.rafa_attachments from public, anon, authenticated/u);
  assert.doesNotMatch(sql, /create policy .*rafa_attachments/iu);
});
