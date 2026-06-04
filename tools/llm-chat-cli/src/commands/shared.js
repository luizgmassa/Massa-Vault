import {
  createInfoScreenAction,
  formatCommandScreenLines
} from "../domain/info-screen.js";
import {
  getCommandDefinitions,
  getCommandPanelLines
} from "./definitions.js";

export function writeMessage(mode, handlers, text) {
  if (mode === "plain") {
    console.log(text);
  } else {
    handlers.message(text);
  }
}

export function writeLines(mode, handlers, title, lines) {
  if (mode === "plain") {
    for (const line of lines) {
      console.log(line);
    }
  } else {
    handlers.panel(title, lines);
  }
}

export function renderCommands(mode, handlers) {
  const commandLines = getCommandPanelLines();
  if (mode === "plain") {
    console.log("Commands:");
    for (const commandLine of commandLines) {
      console.log(`  ${commandLine}`);
    }
    return { handled: true, exit: false };
  } else {
    return {
      handled: true,
      exit: false,
      action: createInfoScreenAction({
        id: "commands",
        title: "Commands",
        lines: formatCommandScreenLines(getCommandDefinitions()),
        scrollable: true
      })
    };
  }
}

export function createHistorySelectionUsage(command) {
  return `Usage : ${command} <number> (pick from current history table)`;
}
