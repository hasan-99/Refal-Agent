import { load as loadHtml } from "cheerio";

const knowledgeHosts = new Set([
  "refalco.com", "www.refalco.com", "northdata.com", "www.northdata.com",
  "instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com",
  "companies.gov.cy", "www.companies.gov.cy"
]);

export function validateKnowledgeUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw httpError(400, "Enter a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !knowledgeHosts.has(url.hostname.toLowerCase())) {
    throw httpError(400, "Only HTTPS pages on Refalco, the supplied social sites, Northdata, and companies.gov.cy are allowed.");
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
        headers: { "user-agent": "RAFA-KnowledgeBot/1.0 (+https://refalco.com)", accept: "text/html,application/xhtml+xml" }
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
  const output = [];
  let heading = "";
  let buffer = "";
  const flush = () => {
    if (!buffer.trim()) return;
    output.push({ chunk_index: output.length, heading, content: buffer.trim(), metadata: {} });
    buffer = "";
  };
  for (const section of paragraphs) {
    heading = section.heading || heading;
    let text = section.content;
    while (text.length > 7000) {
      const splitAt = text.lastIndexOf(" ", 7000);
      const boundary = splitAt > 3000 ? splitAt : 7000;
      const part = text.slice(0, boundary);
      if (buffer.length + part.length > 6500) flush();
      buffer += `${buffer ? "\n\n" : ""}${part}`;
      flush();
      text = text.slice(boundary).trim();
    }
    if (buffer.length + text.length > 6500) flush();
    buffer += `${buffer ? "\n\n" : ""}${text}`;
  }
  flush();
  return output.slice(0, 500);
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
