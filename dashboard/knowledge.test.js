import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import {
  assertPasteWithinLimit,
  chunkKnowledge,
  extractKnowledgeText,
  extractUploadedDocument,
  MAX_PASTE_CHARS,
  MAX_UPLOAD_BYTES,
  validateKnowledgeUrl
} from "./knowledge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildTestPdfBuffer(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.text(text);
    doc.end();
  });
}

// A minimal, valid, STORED-mode (uncompressed) .docx built by hand from the
// three OOXML parts mammoth actually needs — no docx-writing dependency
// exists in this project, and mammoth's own bundled test fixtures are all
// under the 40-char MIN_EXTRACTED_CHARS floor (confirmed by inspection), so
// this is the only way to exercise a REAL successful long-DOCX extraction.
function buildMinimalDocx(paragraphText) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const escaped = String(paragraphText).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p></w:body></w:document>`;

  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") }
  ];

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = zlib.crc32(entry.data) >>> 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDirectory, eocd]);
}

test("source URLs accept only explicitly configured HTTPS hosts and strip fragments", (t) => {
  const previous = process.env.KNOWLEDGE_ALLOWED_HOSTS;
  delete process.env.KNOWLEDGE_ALLOWED_HOSTS;
  assert.throws(() => validateKnowledgeUrl("https://example.invalid/about"), /Only HTTPS/);
  process.env.KNOWLEDGE_ALLOWED_HOSTS = "example.invalid";
  t.after(() => { if (previous === undefined) delete process.env.KNOWLEDGE_ALLOWED_HOSTS; else process.env.KNOWLEDGE_ALLOWED_HOSTS = previous; });
  assert.equal(validateKnowledgeUrl("https://example.invalid/about#team").href, "https://example.invalid/about");
  for (const value of ["http://example.invalid", "https://127.0.0.1", "https://example.com", "https://user:pass@example.invalid", "https://example.invalid:8443"]) {
    assert.throws(() => validateKnowledgeUrl(value), /Only HTTPS/);
  }
});

test("extractor omits navigation and scripts while preserving page headings", () => {
  const html = `<html><head><title>the business profile</title><script>internal noise</script></head><body>
    <nav>Navigation content that should never reach customers</nav><main><h1>Company overview</h1>
    <p>the business develops and operates long-term projects across multiple company operating areas and markets.</p>
    <h2>Approach</h2><p>The company describes an integrated operating platform and a long-horizon approach for its projects.</p>
    </main><footer>Footer content excluded from the imported knowledge.</footer></body></html>`;
  const result = extractKnowledgeText(html, "https://example.invalid/about");
  assert.equal(result.title, "the business profile");
  assert.match(result.content, /Company overview/);
  assert.match(result.content, /Approach/);
  assert.doesNotMatch(result.content, /Navigation content|Footer content|internal noise/);
  assert.ok(result.chunks.length > 0);
});

test("chunker emits ordered bounded chunks for long paragraphs", () => {
  const chunks = chunkKnowledge("A useful sentence ".repeat(1200));
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_chunk, index) => index));
  assert.ok(chunks.every((chunk) => chunk.content.length <= 12000));
});

// REFAL-ADMIN-KB — admin upload path (PDF/DOCX/TXT), as opposed to the
// URL-scraper path tested above.

test("TXT upload preserves English, Arabic, and Greek Unicode unchanged", async () => {
  const text = "the business offers investment services.\nالشركة تقدم خدمات استثمارية في قبرص وخارجها.\nΗ the business προσφέρει επενδυτικές υπηρεσίες σε πολλές χώρες.";
  const result = await extractUploadedDocument({ buffer: Buffer.from(text, "utf8"), mimeType: "text/plain", filename: "notes.txt" });
  assert.match(result.content, /the business offers investment services\./);
  assert.match(result.content, /الشركة تقدم خدمات استثمارية/);
  assert.match(result.content, /Η the business προσφέρει επενδυτικές υπηρεσίες/);
  assert.equal(result.sourceFileType, "txt");
  assert.ok(result.chunks.length > 0);
});

test("PDF upload extracts real text content (English only — pdfkit's base-14 fonts cannot encode Arabic/Greek without an embedded font, so that is out of scope for this generated fixture)", async () => {
  const buffer = await buildTestPdfBuffer("the business provides company formation and investment advisory services across Cyprus.");
  const result = await extractUploadedDocument({ buffer, mimeType: "application/pdf", filename: "brochure.pdf" });
  assert.match(result.content, /the business provides company formation/);
  assert.equal(result.sourceFileType, "pdf");
  assert.ok(result.chunks.length > 0);
});

test("DOCX upload extracts real text content from a hand-built, well-formed long document", async () => {
  const paragraph = "the business DOCX knowledge ingestion test paragraph with enough length to clear the minimum extracted-text floor. ".repeat(2);
  const buffer = buildMinimalDocx(paragraph);
  const result = await extractUploadedDocument({
    buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "brief.docx"
  });
  assert.match(result.content, /the business DOCX knowledge ingestion test paragraph/);
  assert.equal(result.sourceFileType, "docx");
  assert.ok(result.chunks.length > 0);
});

test("DOCX upload enforces the minimum-extracted-text floor on a real, valid, but too-short DOCX", async () => {
  // dashboard/testFixtures/sample.docx is a byte-for-byte copy of mammoth's
  // own real test fixture ("single-paragraph.docx"); its extracted raw text
  // is "Walking on imported air\n\n" (~24 chars) — under the 40-char floor.
  // This asserts REJECTION, proving the same too-short-extraction guard that
  // TXT/PDF get also applies to a real, well-formed DOCX, not just a
  // corrupt-file case.
  const buffer = fs.readFileSync(path.join(__dirname, "testFixtures", "sample.docx"));
  await assert.rejects(
    extractUploadedDocument({
      buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "sample.docx"
    }),
    (error) => error.code === 422
  );
});

test("a corrupt PDF/DOCX buffer is rejected with a 422, never a crash", async () => {
  const garbage = Buffer.from("not a real pdf or docx, just plain bytes pretending to be one");
  await assert.rejects(
    extractUploadedDocument({ buffer: garbage, mimeType: "application/pdf", filename: "fake.pdf" }),
    (error) => error.code === 422
  );
  await assert.rejects(
    extractUploadedDocument({ buffer: garbage, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "fake.docx" }),
    (error) => error.code === 422
  );
});

test("an empty file is rejected with a 400", async () => {
  await assert.rejects(
    extractUploadedDocument({ buffer: Buffer.alloc(0), mimeType: "text/plain", filename: "empty.txt" }),
    (error) => error.code === 400
  );
});

test("a file exceeding MAX_UPLOAD_BYTES is rejected with a 413", async () => {
  await assert.rejects(
    extractUploadedDocument({ buffer: Buffer.alloc(MAX_UPLOAD_BYTES + 1), mimeType: "text/plain", filename: "huge.txt" }),
    (error) => error.code === 413
  );
});

test("an unsupported mime type is rejected with a 415", async () => {
  await assert.rejects(
    extractUploadedDocument({ buffer: Buffer.from("fake image bytes"), mimeType: "image/png", filename: "photo.png" }),
    (error) => error.code === 415
  );
});

test("assertPasteWithinLimit allows content at the limit and rejects content over it with a 413", () => {
  assert.doesNotThrow(() => assertPasteWithinLimit("x".repeat(MAX_PASTE_CHARS)));
  assert.throws(() => assertPasteWithinLimit("x".repeat(MAX_PASTE_CHARS + 1)), (error) => error.code === 413);
});
