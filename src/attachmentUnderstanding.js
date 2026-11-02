"use strict";

const zlib = require("node:zlib");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { redactSensitiveData } = require("./sensitiveData");
const { describeCustomerImage, describeCustomerPdf } = require("./imageUnderstanding");

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 9000;
const MAX_ARCHIVE_ENTRIES = 2048;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".tsv", ".md", ".log", ".json", ".xml"]);
const TEXT_MIMES = new Set(["text/plain", "text/csv", "text/tab-separated-values", "text/markdown", "application/json", "application/xml", "text/xml"]);
const OFFICE_MIMES = Object.freeze({
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel"
});

function attachmentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isAttachmentMessageKindCompatible(messageKind, detectedKind) {
  return messageKind === "document" || (messageKind === "image" && detectedKind === "image");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
  const entries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_ARCHIVE_ENTRIES || directoryOffset + directorySize > eocd) {
    throw attachmentError("ATTACHMENT_UNSAFE_ARCHIVE", "Office archive exceeds processing limits.");
  }
  const found = new Map();
  let offset = directoryOffset;
  let totalSize = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!nameLength || offset + 46 + nameLength + extraLength + commentLength > buffer.length
        || name.startsWith("/") || name.split(/[\\/]/u).includes("..")) {
      throw attachmentError("ATTACHMENT_UNSAFE_ARCHIVE", "Office archive contains an unsafe entry.");
    }
    totalSize += size;
    if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES || size > 8 * 1024 * 1024
        || (size > 0 && compressedSize === 0) || (compressedSize > 0 && size / compressedSize > 250)) {
      throw attachmentError("ATTACHMENT_UNSAFE_ARCHIVE", "Office archive exceeds processing limits.");
    }
    if (method !== 0 && method !== 8) throw attachmentError("ATTACHMENT_UNSUPPORTED", "Office archive compression is unsupported.");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
    found.set(name, { method, compressedSize, size, dataOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive.");
  return found;
}

function zipEntryText(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  let bytes;
  try {
    const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    bytes = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: entry.size });
  } catch {
    throw attachmentError("ATTACHMENT_CORRUPT", "Office archive could not be decompressed.");
  }
  if (bytes.length !== entry.size) throw attachmentError("ATTACHMENT_CORRUPT", "Invalid office archive entry.");
  return bytes.toString("utf8");
}

function decodeXml(value) {
  return String(value || "").replace(/&#x([\da-f]{1,6});/giu, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/gu, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

function xmlText(xml) {
  return decodeXml(String(xml || "").replace(/<w:tab\b[^>]*\/?\s*>/gu, "\t").replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/gu, "\n")
    .replace(/<\/w:p\s*>/gu, "\n").replace(/<[^>]+>/gu, ""));
}

function extractDocx(buffer, entries) {
  if (!entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) {
    throw attachmentError("ATTACHMENT_TYPE_MISMATCH", "File contents do not match a Word document.");
  }
  return xmlText(zipEntryText(buffer, entries, "word/document.xml"));
}

function extractXlsx(buffer, entries) {
  if (!entries.has("[Content_Types].xml") || !entries.has("xl/workbook.xml")) {
    throw attachmentError("ATTACHMENT_TYPE_MISMATCH", "File contents do not match an Excel workbook.");
  }
  const sharedXml = zipEntryText(buffer, entries, "xl/sharedStrings.xml") || "";
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((match) => xmlText(match[1]).replace(/\n/gu, " "));
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  const lines = [];
  for (let index = 0; index < sheets.length; index += 1) {
    const sheetXml = zipEntryText(buffer, entries, sheets[index]);
    if (!sheetXml) continue;
    lines.push(`Sheet ${index + 1}`);
    for (const row of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
        const reference = /\br="([A-Z]+\d+)"/u.exec(cell[1])?.[1] || "";
        const type = /\bt="([^"]+)"/u.exec(cell[1])?.[1] || "";
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(cell[2])?.[1];
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/u.exec(cell[2])?.[1];
        let text = inline !== undefined ? xmlText(inline).replace(/\n/gu, " ") : value === undefined ? "" : decodeXml(value);
        if (type === "s" && value !== undefined) text = sharedStrings[Number(value)] || "";
        if (text !== "") cells.push(`${reference}=${text}`);
      }
      if (cells.length) lines.push(cells.join(" | "));
    }
  }
  return lines.join("\n");
}

function sniffAttachment(buffer, fileName, declaredMime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw attachmentError("ATTACHMENT_CORRUPT", "Attachment is empty.");
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw attachmentError("ATTACHMENT_TOO_LARGE", "Attachment is too large.");
  if (buffer.length < 4) throw attachmentError("ATTACHMENT_CORRUPT", "Attachment is incomplete.");
  const ext = require("node:path").extname(String(fileName || "").toLowerCase());
  const declared = String(declaredMime || "").toLowerCase().split(";")[0].trim();
  let detected = null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) detected = { kind: "image", mimeType: "image/jpeg" };
  else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = { kind: "image", mimeType: "image/png" };
  else if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") detected = { kind: "image", mimeType: "image/webp" };
  else if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp" && /^(?:heic|heix|hevc|hevx|mif1|msf1)$/u.test(buffer.toString("ascii", 8, 12))) detected = { kind: "image", mimeType: "image/heic" };
  else if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") detected = { kind: "pdf", mimeType: "application/pdf" };
  else if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    if (ext === ".doc") detected = { kind: "legacy_doc", mimeType: OFFICE_MIMES[ext] };
    else if (ext === ".xls") detected = { kind: "legacy_xls", mimeType: OFFICE_MIMES[ext] };
    else throw attachmentError("ATTACHMENT_PASSWORD_PROTECTED", "Encrypted Office documents are not supported.");
  } else if (buffer.readUInt32LE(0) === 0x04034b50) {
    const entries = readZipEntries(buffer);
    if (entries.has("word/document.xml") && ext === ".docx") detected = { kind: "docx", mimeType: OFFICE_MIMES[ext], entries };
    else if (entries.has("xl/workbook.xml") && ext === ".xlsx") detected = { kind: "xlsx", mimeType: OFFICE_MIMES[ext], entries };
    else throw attachmentError("ATTACHMENT_TYPE_MISMATCH", "File contents do not match a supported document type.");
  } else if (TEXT_EXTENSIONS.has(ext)) {
    const text = decodeTextBuffer(buffer);
    if (!text) throw attachmentError("ATTACHMENT_CORRUPT", "Text attachment could not be decoded safely.");
    detected = { kind: "text", mimeType: ext === ".csv" ? "text/csv" : ext === ".tsv" ? "text/tab-separated-values" : ext === ".json" ? "application/json" : ext === ".xml" ? "application/xml" : ext === ".md" ? "text/markdown" : "text/plain" };
  }
  if (!detected) throw attachmentError("ATTACHMENT_UNSUPPORTED", "This attachment type is not supported.");
  const mimeMatches = !declared || declared === "application/octet-stream" || declared === "binary/octet-stream"
    || declared === detected.mimeType || (detected.kind === "text" && TEXT_MIMES.has(declared));
  const extMatches = !ext || ext === ".bin" || (detected.kind === "image" && { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"], "image/heic": [".heic", ".heif"] }[detected.mimeType]?.includes(ext))
    || (detected.kind === "pdf" && ext === ".pdf") || (detected.kind === "text" && TEXT_EXTENSIONS.has(ext))
    || (detected.kind.startsWith("legacy_") && OFFICE_MIMES[ext] === detected.mimeType)
    || ((detected.kind === "docx" || detected.kind === "xlsx") && OFFICE_MIMES[ext] === detected.mimeType);
  if (!mimeMatches || !extMatches) throw attachmentError("ATTACHMENT_TYPE_MISMATCH", "Attachment type does not match its file signature.");
  if (detected.kind === "pdf" && buffer.toString("latin1").includes("/Encrypt")) throw attachmentError("ATTACHMENT_PASSWORD_PROTECTED", "Password-protected PDFs are not supported.");
  return detected;
}

function decodeTextBuffer(buffer) {
  try {
    let text;
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const bytes = Buffer.from(buffer.subarray(2));
      for (let index = 0; index + 1 < bytes.length; index += 2) [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
      text = bytes.toString("utf16le");
    }
    if (text === undefined) text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/u, "");
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? null : text;
  } catch { return null; }
}

function selectRelevantContent(text, question, maxChars = MAX_ATTACHMENT_TEXT_CHARS) {
  const normalized = String(text || "").replace(/\u0000/gu, " ").trim();
  if (!normalized) return "";
  const blocks = normalized.split(/\n{2,}|(?<=\.)\s+(?=[A-Z0-9])/u).map((item) => item.trim()).filter(Boolean);
  if (normalized.length <= maxChars) return normalized;
  const terms = [...new Set(String(question || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0, 24);
  const ranked = blocks.map((block, index) => ({ block, index, score: terms.reduce((sum, term) => sum + (block.toLowerCase().includes(term) ? 1 : 0), 0) }));
  if (terms.length) ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  let used = 0;
  for (const item of ranked) {
    const addition = (selected.length ? 2 : 0) + item.block.length;
    if (used + addition > maxChars) continue;
    selected.push(item);
    used += addition;
  }
  selected.sort((left, right) => left.index - right.index);
  return selected.map((item) => item.block).join("\n\n");
}

function extractAttachmentText(buffer, descriptor) {
  if (descriptor.kind === "docx") return extractDocx(buffer, descriptor.entries);
  if (descriptor.kind === "xlsx") return extractXlsx(buffer, descriptor.entries);
  if (descriptor.kind === "text") return decodeTextBuffer(buffer) || "";
  if (descriptor.kind === "legacy_doc" || descriptor.kind === "legacy_xls") {
    throw attachmentError("ATTACHMENT_PARSER_UNAVAILABLE", "Legacy Office files need a document converter that is not installed.");
  }
  throw attachmentError("ATTACHMENT_PARSER_UNAVAILABLE", "This attachment needs vision processing.");
}

function safeAttachmentFileName(value, fallback = "attachment") {
  const base = path.basename(String(value || "").replace(/\\/gu, "/"));
  const safe = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 160);
  return safe || fallback;
}

async function downloadCustomerAttachment(message, socket, downloadMediaMessage) {
  if (typeof downloadMediaMessage !== "function") throw attachmentError("ATTACHMENT_DOWNLOAD_UNAVAILABLE", "Attachment download is unavailable.");
  const stream = await downloadMediaMessage(message, "stream", {}, { reuploadRequest: socket?.updateMediaMessage });
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      stream.destroy?.();
      throw attachmentError("ATTACHMENT_TOO_LARGE", "Attachment is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function understandCustomerAttachment(buffer, descriptor, question = "") {
  let extracted;
  if (descriptor.kind === "image") extracted = await describeCustomerImage(buffer, question);
  else if (descriptor.kind === "pdf") extracted = await describeCustomerPdf(buffer, question);
  else extracted = redactSensitiveData(extractAttachmentText(buffer, descriptor));
  const content = selectRelevantContent(extracted, question);
  if (!content.trim()) throw attachmentError("ATTACHMENT_EMPTY", "No readable content was extracted.");
  return { content, sha256: createHash("sha256").update(buffer).digest("hex") };
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  decodeTextBuffer,
  downloadCustomerAttachment,
  extractAttachmentText,
  isAttachmentMessageKindCompatible,
  readZipEntries,
  safeAttachmentFileName,
  selectRelevantContent,
  sniffAttachment,
  understandCustomerAttachment
};
