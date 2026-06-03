import { createCommandSpec } from "../definitions.js";
import { writeMessage } from "../shared.js";

export function createSearchCommandSpecs(deps) {
  return [
    createCommandSpec(
      "/search",
      async ({ mode, handlers, parsed, historySearchRunner }) => {
        if (!parsed.value) {
          writeMessage(mode, handlers, "Usage : /search <query>");
          return { handled: true, exit: false };
        }
        const searchResult = await historySearchRunner({ query: parsed.value });
        if (mode === "plain") {
          deps.printSearchPlain(searchResult);
        } else {
          handlers.panel("search", deps.formatSearchPanel(searchResult));
        }
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    )
  ];
}
