export const CHAT_COMMAND_DEFINITIONS = Object.freeze([
  {
    command: "/sync",
    description: "Save transcript (if needed) and trigger sync"
  },
  {
    command: "/sync status",
    description: "Open live sync status screen (TUI) / print JSON status (plain)"
  },
  {
    command: "/sync conflicts",
    description: "Show sync conflict details"
  },
  {
    command: "/conv",
    description: "Return from sync status screen to conversation (TUI)"
  },
  {
    command: "/back",
    description: "Back in history flow (preview/summary -> conversations -> dates -> conversation)"
  },
  {
    command: "/history",
    description: "Open history screen with transcript dates"
  },
  {
    command: "/history date",
    description: "Show conversation rows for date number or YYYY-MM-DD",
    requiresInput: true
  },
  {
    command: "/history search",
    description: "Semantic search only in AI Chats transcripts",
    requiresInput: true
  },
  {
    command: "/history switch",
    description: "Switch active conversation to selected history row",
    requiresInput: true
  },
  {
    command: "/history add_context",
    description: "Inject selected history conversation into next prompt",
    requiresInput: true
  },
  {
    command: "/history summary",
    description: "Generate short LLM summary for selected history row",
    requiresInput: true
  },
  {
    command: "/history preview",
    description: "Open full transcript preview for selected history row",
    requiresInput: true
  },
  {
    command: "/exit",
    description: "Save transcript and exit"
  },
  {
    command: "/clear",
    description: "Clear conversation memory"
  },
  {
    command: "/usage",
    description: "Show token counters and quota estimates"
  },
  {
    command: "/config",
    description: "Show active gateway/system settings"
  },
  {
    command: "/system show",
    description: "Show system prompt"
  },
  {
    command: "/system set",
    description: "Set system prompt",
    requiresInput: true
  },
  {
    command: "/system clear",
    description: "Clear system prompt"
  },
  {
    command: "/routing",
    description: "Show latest router metadata"
  },
  {
    command: "/search",
    description: "Semantic search in chats + vault markdown",
    requiresInput: true
  }
]);

function startsWithCommand(line, command) {
  return line === command || line.startsWith(`${command} `);
}

function commandMeta(command) {
  return CHAT_COMMAND_DEFINITIONS.find((definition) => definition.command === command) || {
    command,
    description: ""
  };
}

export function createCommandSpec(command, run, { requiresInput = false } = {}) {
  return {
    ...commandMeta(command),
    requiresInput,
    match: (line) => (requiresInput ? startsWithCommand(line, command) : line === command),
    parse: (line) =>
      requiresInput
        ? { value: line.slice(command.length).trim() }
        : { value: "" },
    run
  };
}

export function getCommandDefinitions() {
  return CHAT_COMMAND_DEFINITIONS;
}

export function getCommandSuggestions(inputValue, definitions = CHAT_COMMAND_DEFINITIONS) {
  const normalized = String(inputValue || "").trim().toLowerCase();
  if (!normalized.startsWith("/")) return [];
  return definitions.filter((definition) => definition.command.startsWith(normalized));
}

export function completeCommandInput(inputValue, definitions = CHAT_COMMAND_DEFINITIONS) {
  const suggestions = getCommandSuggestions(inputValue, definitions);
  if (suggestions.length !== 1) return String(inputValue || "");
  const selected = suggestions[0];
  return selected.requiresInput ? `${selected.command} ` : selected.command;
}

export function resolveCommandSubmission(definition) {
  const command = String(definition?.command || "").trim();
  if (!command) return null;
  if (definition?.requiresInput) {
    return { mode: "fill", line: `${command} ` };
  }
  return { mode: "submit", line: command };
}

export function getCommandPanelLines(definitions = CHAT_COMMAND_DEFINITIONS) {
  const commandLabel = (definition) => (definition.requiresInput ? `${definition.command} ...` : definition.command);
  const width = definitions.reduce((max, definition) => Math.max(max, commandLabel(definition).length), 0);
  return definitions.map(
    (definition) => `${commandLabel(definition).padEnd(width)}  ${definition.description}`
  );
}
