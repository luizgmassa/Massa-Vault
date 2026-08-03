// Child-process failures carry the useful detail in stderr, not message —
// prefer it, then fall back to the generic error shape. This is the
// deliberate sibling of the repo-wide `error instanceof Error ? error.message
// : String(error)` idiom for errors thrown by spawned tools (git, rclone).
// Test: node --test tests/notes-automation-git.test.js
export function formatProcessError(error) {
  return String(error?.stderr || error?.message || error || "").trim();
}
