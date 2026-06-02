import {
  completeCommandInput,
  getCommandSuggestions,
  resolveCommandSubmission
} from "./commands.js";

export function modelStatusFromRouting(routing) {
  const displayCandidates = [routing?.displayModel, routing?.responseModel, routing?.targetModel]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !value.toLowerCase().startsWith("smart-router"));
  const displayModel = displayCandidates[0] || "";
  const modelLocation = String(routing?.modelLocation || "").trim();
  return {
    displayModel: displayModel || "pending",
    modelLocation: modelLocation || "unknown"
  };
}

export function itemsFromConversationHistory(history, { startAt = 0 } = {}) {
  const entries = Array.isArray(history) ? history : [];
  const items = [];
  let nextId = Math.max(0, Number(startAt) || 0);
  for (const entry of entries) {
    const role = String(entry?.role || "").trim().toLowerCase();
    const content = String(entry?.content || "").trim();
    if (!role || !content) continue;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    nextId += 1;
    items.push({
      id: `h-${nextId}`,
      kind: "message",
      role,
      content
    });
  }
  return {
    items,
    nextId
  };
}

export function getSlashCommandSuggestions(inputValue) {
  return getCommandSuggestions(inputValue);
}

export function tabCompleteSlashCommandInput(inputValue) {
  return completeCommandInput(inputValue);
}

export function moveSlashSuggestionSelection({ currentIndex, suggestionCount, direction }) {
  const count = Math.max(0, Number(suggestionCount) || 0);
  if (!count) return null;
  if (direction !== "up" && direction !== "down") {
    return Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
  }
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) {
    return direction === "up" ? count - 1 : 0;
  }
  if (direction === "up") {
    return (currentIndex - 1 + count) % count;
  }
  return (currentIndex + 1) % count;
}

export function resolveSlashEnterAction({ inputValue, suggestions, selectedIndex }) {
  if (!String(inputValue || "").trim().startsWith("/")) return null;
  const visibleSuggestions = Array.isArray(suggestions) ? suggestions : [];
  if (!visibleSuggestions.length) return null;
  const nextIndex =
    Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < visibleSuggestions.length
      ? selectedIndex
      : 0;
  return resolveCommandSubmission(visibleSuggestions[nextIndex]);
}
