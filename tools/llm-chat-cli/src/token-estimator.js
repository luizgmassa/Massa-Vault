const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_TOKEN_WEIGHT = 1.3;
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokensFromText(text) {
  const value = String(text || "");
  if (!value) return 0;

  let weightedChars = 0;
  for (const char of value) {
    weightedChars += char.charCodeAt(0) > 127 ? NON_ASCII_TOKEN_WEIGHT : 1;
  }
  return Math.max(1, Math.ceil(weightedChars / ASCII_CHARS_PER_TOKEN));
}

export function estimateConversationTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => {
    const content = typeof message?.content === "string" ? message.content : "";
    return total + MESSAGE_OVERHEAD_TOKENS + estimateTokensFromText(content);
  }, 0);
}
