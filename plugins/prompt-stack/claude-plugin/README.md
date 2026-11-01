# prompt-stack

Stack the skills you want and a `UserPromptSubmit` hook prints their cards beside every prompt. The agent then opens with a Brief block (Objective / Surface / Answer key / Comparison / ... / Skills to invoke) and works from that.

- `/prompt-stack:stack add prove spec` sets the project stack. `--thread` sets this thread only.
- Type `+audit` or `-spec` in a prompt to change that one prompt.
- `PROMPT_STACK=off` silences the hook. Slash-command prompts are never injected.
- Entries live in `stack.json` (id, aliases, card, skill, brief_fields). Add your own there.
- Stack files: `~/.claude/prompt-stack/` (projects keyed by repo root, threads by `BB_THREAD_ID` or the Claude session id).

The verifier idea and the `create-prove-it`, `maintain-prove-it` and `audit-prove-it` skills come from Ray Amjad, "Verification is the new code review", vendored verbatim under MIT (see each `SOURCE.md`).
