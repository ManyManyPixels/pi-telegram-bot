const MAX_COMMENT_LENGTH = 65536;

/**
 * Split a response into chunks that fit within GitHub's comment limit.
 * Simple boundary-based split with no continuation markers.
 */
function splitResponse(text) {
  if (text.length <= MAX_COMMENT_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_COMMENT_LENGTH) {
    chunks.push(remaining.slice(0, MAX_COMMENT_LENGTH));
    remaining = remaining.slice(MAX_COMMENT_LENGTH);
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

module.exports = { splitResponse };
