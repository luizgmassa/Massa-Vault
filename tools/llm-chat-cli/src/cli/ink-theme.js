// Chat UI color theme, extracted so ink-markdown.js and ink-repl.js can both
// depend on it without a two-way sibling import.
// Test: node --test tests/llm-chat-cli-ink.test.js
export const CHAT_THEME = {
  assistant: "#ffb86b",
  system: "#ffb86b",
  header: "#d97706",
  user: "#2f9e44",
  muted: "gray",
  code: "yellow"
};
