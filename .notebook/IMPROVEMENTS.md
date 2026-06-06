# Improvements

## Vault RAG

- Add `hybrid` to displayed or declared vault context modes, or clarify that `semantic, manifest` are the public categories while hybrid is an internal combined mode.
- Make chunk limit and max chars configurable through config or environment variables.
- Replace character-based chunking with markdown- or heading-aware chunking.
- Add result diversity so top chunks do not all come from the same file when broader coverage would help.
- Ensure hybrid metadata sources match the visible, non-truncated context.
- Add intent debug reasons or more intent tests for the regex classifier.
- Consider incremental or background index rebuilds for large vaults.
