import { formatSearchScreenLines } from "../domain/info-screen.js";

export function formatSearchPanel({ rebuilt, results }) {
  const lines = [];
  if (rebuilt) {
    lines.push("index rebuilt");
  }
  if (!results.length) {
    lines.push("no results");
    return lines;
  }

  for (const result of results) {
    lines.push(
      `${result.filePath}#${result.chunkIndex} score=${result.score.toFixed(4)} ${result.snippet}`
    );
  }
  return lines;
}

export function printSearchPlain(searchResult) {
  if (searchResult.rebuilt) {
    console.log("[chat-search] index rebuilt");
  }
  if (!searchResult.results.length) {
    console.log("[chat-search] no results");
    return;
  }
  for (const line of formatSearchPanel(searchResult)) {
    if (line === "index rebuilt") continue;
    console.log(`- ${line}`);
  }
}

export { formatSearchScreenLines };
