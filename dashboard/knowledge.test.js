import test from "node:test";
import assert from "node:assert/strict";
import { chunkKnowledge, extractKnowledgeText, validateKnowledgeUrl } from "./knowledge.js";

test("source URLs accept only approved HTTPS hosts and strip fragments", () => {
  assert.equal(validateKnowledgeUrl("https://www.refalco.com/about#team").href, "https://www.refalco.com/about");
  for (const value of ["http://refalco.com", "https://127.0.0.1", "https://example.com", "https://user:pass@refalco.com", "https://refalco.com:8443"]) {
    assert.throws(() => validateKnowledgeUrl(value), /Only HTTPS/);
  }
});

test("extractor omits navigation and scripts while preserving page headings", () => {
  const html = `<html><head><title>Refalco profile</title><script>internal noise</script></head><body>
    <nav>Navigation content that should never reach customers</nav><main><h1>Company overview</h1>
    <p>Refalco develops and operates long-term projects across multiple company operating areas and markets.</p>
    <h2>Approach</h2><p>The company describes an integrated operating platform and a long-horizon approach for its projects.</p>
    </main><footer>Footer content excluded from the imported knowledge.</footer></body></html>`;
  const result = extractKnowledgeText(html, "https://www.refalco.com/about");
  assert.equal(result.title, "Refalco profile");
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
