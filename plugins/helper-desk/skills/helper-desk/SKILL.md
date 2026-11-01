---
name: helper-desk
description: Helper Desk shows you what sub-agents are doing in a bb thread. Use `bb helper-desk show <thread-id>` to read the same snapshot from the terminal.
---

# Helper Desk

Helper Desk draws two things in every Claude Code thread:

- a taskbar above the composer: the thread's to-do list as "Tasks n/m", or, when there is no to-do list, the current sub-agent batch as "Agents n/m", with "Now:" naming the current step;
- an orchestrator card for this thread's own agent ("Lead · model": working, waiting for you, or needs you, with its current activity, context used and estimated session cost), with sub-agents hanging beneath it as a tree;
- a Helper Desk side panel (opens itself once per batch when the first sub-agent starts, or from the thread header button): total chat cost, sub-agent tokens, elapsed time, and one card per sub-agent with its tokens, time, current step and progress.

Read the snapshot an agent would see: `bb helper-desk show <thread-id>` (JSON, bounded).
Read past agent batches on a thread, newest first: `bb helper-desk history <thread-id>`.

When a batch finishes, its cards leave the live view after a short delay (setting "Auto-hide finished agents", default on, delay default 8 seconds: `bb plugin config helper-desk set hideDelaySeconds 12`). Past batches stay in the History tab.

The lead's face is the coach. The same coach also lives on top of bb as a companion: his eyes follow the pointer, he wanders over to a resting pointer, perches above the caret while you type (thinks when you pause, celebrates when you send), closes his eyes on password fields, goes to the composer when the chat needs you, and sleeps after 90 seconds of quiet. He follows the chat in view, never takes a click, reads only pointer and caret positions (never text) and hides on phone-sized screens. Turn it off with `bb plugin config helper-desk set companion false` (back on: `bb plugin config helper-desk unset companion`).

Notes for agents:
- Tokens are each sub-agent's latest context size, as Claude Code reports it.
- "est." cost is an API-equivalent estimate from the local Claude Code transcripts; on a subscription nothing is billed per token.
- The chat total covers the whole session: the lead, every sub-agent, every Workflow agent (`<session>/subagents/workflows/`) and every advisor call (priced at the advisor's model, Fable at $10/$50 per million). The panel shows the split under the total. The lead card shows only the lead's own replies, the same figure as "Lead" in the split.
- Progress for a running agent assumes about eight steps and stops at 95% until it reports back.
- A running agent with no sign of life for 30 minutes shows as interrupted.
- Nothing here changes the thread. It only reads bb events and local transcripts.
