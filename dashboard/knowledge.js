import { load as loadHtml } from "cheerio";
import mammoth from "mammoth";

// REFAL-ADMIN-KB — admin-uploaded/pasted company knowledge (PDF/DOCX/TXT or
// large pasted text), as opposed to the URL-scraper path above. Reuses
// normalizeKnowledgeContent/chunkKnowledge so both ingestion paths produce
// the identical bounded, ordered chunk shape storeKnowledgeRevision expects.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // enforced again here as a second check behind multer's own limit
export const MAX_PASTE_CHARS = 250_000; // matches the page-import content cap already applied in server.js's storeKnowledgeRevision
const MIN_EXTRACTED_CHARS = 40; // matches the existing manual paste-import floor in server.js

export const UPLOAD_MIME_TYPES = Object.freeze({
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
});

function titleFromFilename(filename) {
  const base = String(filename || "").replace(/\.[^./\\]+$/, "").trim();
  return base ? base.slice(0, 500) : "Uploaded document";
}

function standardFontDataUrl() {
  return new URL("./node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;
}

async function extractPdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: standardFontDataUrl(),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false
    }).promise;
  } catch (error) {
    throw httpError(422, `The PDF could not be read (${error.message || "corrupt file"}).`);
  }
  try {
    let text = "";
    for (let page = 1; page <= doc.numPages; page += 1) {
      const current = await doc.getPage(page);
      const content = await current.getTextContent();
      text += content.items.map((item) => item.str || "").join(" ") + "\n";
    }
    return text;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

async function extractDocxText(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    throw httpError(422, `The DOCX file could not be read (${error.message || "corrupt file"}).`);
  }
}

function extractTxtText(buffer) {
  if (buffer.includes(0)) throw httpError(422, "The file does not look like readable text.");
  return buffer.toString("utf8");
}

// The one entry point server.js calls for an uploaded file. `buffer` is
// already size-bounded by multer's own `limits.fileSize` (see server.js);
// `MAX_UPLOAD_BYTES` here is a second, independent check so this function is
// safe even if it is ever called from somewhere that skipped multer.
export async function extractUploadedDocument({ buffer, mimeType, filename, title, language } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, "The uploaded file is empty.");
  if (buffer.length > MAX_UPLOAD_BYTES) throw httpError(413, "The uploaded file exceeds the upload size limit.");
  const kind = UPLOAD_MIME_TYPES[mimeType];
  if (!kind) throw httpError(415, "Only TXT, PDF, and DOCX files are supported.");

  const rawText = kind === "pdf" ? await extractPdfText(buffer)
    : kind === "docx" ? await extractDocxText(buffer)
    : extractTxtText(buffer);

  const content = normalizeKnowledgeContent(rawText).slice(0, MAX_PASTE_CHARS);
  if (content.length < MIN_EXTRACTED_CHARS) throw httpError(422, "The file did not contain enough readable text to import.");

  return {
    title: String(title || "").trim().slice(0, 500) || titleFromFilename(filename),
    content,
    chunks: chunkKnowledge(content),
    sourceFileType: kind,
    sourceFileName: String(filename || "").slice(0, 300),
    language: String(language || "en").slice(0, 8)
  };
}

// Shared bound for the paste-text import path (server.js's /:id/import),
// kept here next to MAX_UPLOAD_BYTES so both limits live in one place.
export function assertPasteWithinLimit(content) {
  if (String(content || "").length > MAX_PASTE_CHARS) {
    throw httpError(413, `Pasted content exceeds the ${MAX_PASTE_CHARS.toLocaleString("en-US")} character limit.`);
  }
}

// Empty by default. Operators explicitly configure permitted import hosts.
function knowledgeHosts() {
  return new Set(String(process.env.KNOWLEDGE_ALLOWED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

export function validateKnowledgeUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw httpError(400, "Enter a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !knowledgeHosts().has(url.hostname.toLowerCase())) {
    throw httpError(400, "Only HTTPS pages on explicitly configured KNOWLEDGE_ALLOWED_HOSTS are allowed. You can also upload a file or paste text.");
  }
  url.hash = "";
  return url;
}

export async function fetchKnowledgePage(initialUrl) {
  let url = validateKnowledgeUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        redirect: "manual", signal: controller.signal,
        headers: { "user-agent": "KnowledgeBot/1.0", accept: "text/html,application/xhtml+xml" }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw httpError(502, "Source redirect limit exceeded.");
        url = validateKnowledgeUrl(new URL(location, url).href);
        continue;
      }
      if ([401, 403, 429].includes(response.status)) throw httpError(response.status, "The source blocks automated retrieval; use reviewed manual text import instead.");
      if (!response.ok) throw httpError(502, `Source returned HTTP ${response.status}.`);
      if (!(response.headers.get("content-type") || "").toLowerCase().includes("html")) throw httpError(415, "The source did not return an HTML page.");
      if (Number(response.headers.get("content-length") || 0) > 2_000_000) throw httpError(413, "Source page exceeds the 2 MB limit.");
      const reader = response.body?.getReader();
      if (!reader) throw httpError(502, "Source response was empty.");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw httpError(413, "Source page exceeds the 2 MB limit.");
        }
        chunks.push(value);
      }
      } finally {
        reader.releaseLock();
      }
      return { html: Buffer.concat(chunks).toString("utf8"), url: url.href };
    } catch (error) {
      if (error.code) throw error;
      throw httpError(502, error.name === "AbortError" ? "Source fetch timed out." : "Source could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }
  throw httpError(502, "Source redirect limit exceeded.");
}

export function extractKnowledgeText(html, sourceUrl) {
  const $ = loadHtml(html);
  $("script,style,noscript,svg,nav,footer,header,form,iframe,button,[aria-hidden='true']").remove();
  const main = $("main").first();
  const article = $("article").first();
  const root = main.text().trim().length > 1000 ? main : article.text().trim().length > 1000 ? article : $("body");
  const title = normalizeKnowledgeContent($("title").first().text() || $("h1").first().text() || new URL(sourceUrl).hostname).slice(0, 500);
  const sections = [];
  let heading = title;
  root.find("h1,h2,h3,h4,p,li,blockquote").each((_index, element) => {
    const node = $(element);
    const text = normalizeKnowledgeContent(node.text());
    if (!text) return;
    if (/^h[1-4]$/.test(element.tagName.toLowerCase())) heading = text.slice(0, 300);
    else if (text.length >= 24) sections.push({ heading, content: text });
  });
  let content = sections.map((section) => `${section.heading}\n${section.content}`).join("\n\n");
  if (content.length < 100) content = normalizeKnowledgeContent(root.text());
  content = content.slice(0, 250_000);
  if (content.length < 100) throw httpError(422, "The page did not contain enough readable text to import.");
  return { title, content, chunks: chunkKnowledge(content, sections) };
}

export function normalizeKnowledgeContent(value) {
  return String(value || "").replace(/\u0000/g, " ").replace(/[\t\f\v ]+/g, " ").replace(/\r/g, "").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function chunkKnowledge(content, sections = []) {
  const paragraphs = sections.length ? sections : normalizeKnowledgeContent(content).split(/\n\s*\n/).map((paragraph) => ({ heading: "", content: paragraph }));
  const maxChunkChars = 1800;
  const preferredMinimumSplit = 700;
  const output = [];
  let heading = "";
  let buffer = "";
  const flush = () => {
    if (!buffer.trim()) return;
    output.push({ chunk_index: output.length, heading, content: buffer.trim(), metadata: {} });
    buffer = "";
  };
  const splitLongText = (value) => {
    const parts = [];
    let remaining = String(value || "").trim();
    while (remaining.length > maxChunkChars) {
      const window = remaining.slice(0, maxChunkChars + 1);
      const sentenceEnds = [...window.matchAll(/[.!?؟。！？](?:\s+|$)/gu)];
      const sentenceBoundary = sentenceEnds.map((match) => match.index + match[0].length).filter((index) => index >= preferredMinimumSplit).at(-1) || -1;
      const lineBoundary = window.lastIndexOf("\n");
      const wordBoundary = window.lastIndexOf(" ");
      const boundary = sentenceBoundary > 0
        ? sentenceBoundary
        : lineBoundary >= preferredMinimumSplit
          ? lineBoundary
          : wordBoundary >= preferredMinimumSplit
            ? wordBoundary
            : maxChunkChars;
      parts.push(remaining.slice(0, boundary).trim());
      remaining = remaining.slice(boundary).trim();
    }
    if (remaining) parts.push(remaining);
    return parts;
  };
  for (const section of paragraphs) {
    const nextHeading = section.heading || heading;
    if (buffer && nextHeading !== heading) flush();
    heading = nextHeading;
    for (const part of splitLongText(section.content)) {
      const separatorLength = buffer ? 2 : 0;
      if (buffer && buffer.length + separatorLength + part.length > maxChunkChars) flush();
      buffer += `${buffer ? "\n\n" : ""}${part}`;
    }
  }
  flush();
  return output.slice(0, 500);
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
