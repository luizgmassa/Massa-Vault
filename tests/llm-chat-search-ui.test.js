import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSearchPanel,
  printSearchPlain
} from "../tools/llm-chat-cli/src/commands/search-ui.js";

function withCapturedConsoleLog(fn) {
  const calls = [];
  const original = console.log;
  console.log = (...args) => {
    calls.push(args.join(" "));
  };
  try {
    return fn(calls);
  } finally {
    console.log = original;
  }
}

test("formatSearchPanel returns 'no results' for an empty result set", () => {
  const lines = formatSearchPanel({ rebuilt: false, results: [] });
  assert.deepEqual(lines, ["no results"]);
});

test("formatSearchPanel prefixes 'index rebuilt' before an empty result set", () => {
  const lines = formatSearchPanel({ rebuilt: true, results: [] });
  assert.deepEqual(lines, ["index rebuilt", "no results"]);
});

test("formatSearchPanel formats a populated result set with score and snippet", () => {
  const lines = formatSearchPanel({
    rebuilt: false,
    results: [
      { filePath: "notes/foo.md", chunkIndex: 0, score: 0.987654, snippet: "hello world" },
      { filePath: "notes/bar.md", chunkIndex: 2, score: 0.5, snippet: "second result" }
    ]
  });
  assert.deepEqual(lines, [
    "notes/foo.md#0 score=0.9877 hello world",
    "notes/bar.md#2 score=0.5000 second result"
  ]);
});

test("formatSearchPanel prefixes 'index rebuilt' before a populated result set", () => {
  const lines = formatSearchPanel({
    rebuilt: true,
    results: [{ filePath: "notes/foo.md", chunkIndex: 0, score: 1, snippet: "hit" }]
  });
  assert.deepEqual(lines, ["index rebuilt", "notes/foo.md#0 score=1.0000 hit"]);
});

test("printSearchPlain logs 'no results' for an empty result set", () => {
  withCapturedConsoleLog((calls) => {
    printSearchPlain({ rebuilt: false, results: [] });
    assert.deepEqual(calls, ["[chat-search] no results"]);
  });
});

test("printSearchPlain logs the 'index rebuilt' branch and then 'no results'", () => {
  withCapturedConsoleLog((calls) => {
    printSearchPlain({ rebuilt: true, results: [] });
    assert.deepEqual(calls, ["[chat-search] index rebuilt", "[chat-search] no results"]);
  });
});

test("printSearchPlain prints a populated result set, skipping the raw 'index rebuilt' formatted line", () => {
  withCapturedConsoleLog((calls) => {
    printSearchPlain({
      rebuilt: true,
      results: [
        { filePath: "notes/foo.md", chunkIndex: 0, score: 0.75, snippet: "hit one" },
        { filePath: "notes/bar.md", chunkIndex: 1, score: 0.25, snippet: "hit two" }
      ]
    });
    assert.deepEqual(calls, [
      "[chat-search] index rebuilt",
      "- notes/foo.md#0 score=0.7500 hit one",
      "- notes/bar.md#1 score=0.2500 hit two"
    ]);
  });
});

test("printSearchPlain prints a populated result set without the rebuilt banner when not rebuilt", () => {
  withCapturedConsoleLog((calls) => {
    printSearchPlain({
      rebuilt: false,
      results: [{ filePath: "notes/foo.md", chunkIndex: 3, score: 0.1, snippet: "hit" }]
    });
    assert.deepEqual(calls, ["- notes/foo.md#3 score=0.1000 hit"]);
  });
});
