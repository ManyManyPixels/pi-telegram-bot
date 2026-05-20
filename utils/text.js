const MAX_COMMENT_LENGTH = 65536;

/**
 * Split a long response into chunks that fit within GitHub's comment limit.
 * Tries to split at paragraph boundaries (double newline), then at sentence
 * boundaries, then falls back to hard cuts.
 */
function splitResponse(text) {
  if (text.length <= MAX_COMMENT_LENGTH) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);

  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_COMMENT_LENGTH) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      if (para.length > MAX_COMMENT_LENGTH) {
        let remaining = para;
        while (remaining.length > MAX_COMMENT_LENGTH) {
          const slice = remaining.slice(0, MAX_COMMENT_LENGTH - 100);
          const lastDot = slice.lastIndexOf(". ");
          const cutPoint =
            lastDot > MAX_COMMENT_LENGTH / 2 ? lastDot + 1 : MAX_COMMENT_LENGTH - 100;
          chunks.push(remaining.slice(0, cutPoint).trim());
          remaining = remaining.slice(cutPoint).trim();
        }
        if (remaining) current = remaining;
      } else {
        current = para;
      }
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) => {
      if (i === 0) return c + `\n\n---\n*(continued in next comment...)*`;
      if (i === total - 1) return `*(...continuation)*\n\n` + c;
      return `*(...continued)*\n\n` + c + `\n\n---\n*(continued...)*`;
    });
  }

  return chunks;
}

module.exports = { splitResponse };
