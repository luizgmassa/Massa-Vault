import { createCommandSpec } from "../definitions.js";
import { createInfoScreenAction } from "../../domain/info-screen.js";
import { writeMessage } from "../shared.js";

export function createSearchCommandSpecs(deps) {
  return [
    createCommandSpec(
      "/search",
      async ({ mode, handlers, parsed, historySearchRunner }) => {
        if (!parsed.value) {
          if (mode === "plain") {
            writeMessage(mode, handlers, "Usage : /search <query>");
            return { handled: true, exit: false };
          }
          return {
            handled: true,
            exit: false,
            action: createInfoScreenAction({
              id: "search",
              title: "Search",
              lines: ["Usage : `/search <query>` | `/back` | `/conv`"]
            })
          };
        }
        const searchResult = await historySearchRunner({ query: parsed.value });
        if (mode === "plain") {
          deps.printSearchPlain(searchResult);
        } else {
          return {
            handled: true,
            exit: false,
            action: createInfoScreenAction({
              id: "search",
              title: "Search",
              lines: deps.formatSearchScreenLines(searchResult),
              scrollable: true
            })
          };
        }
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    )
  ];
}
