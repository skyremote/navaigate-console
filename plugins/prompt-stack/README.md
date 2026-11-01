# bb-plugin-prompt-stack

A bb side-panel action, **Prompt stack**, that sets the prompt stack for the current thread with tick boxes.

- Backend (`server.ts`): RPC `state`, `set`, `useProjectDefault`. Each runs the prompt-stack CLI with `BB_THREAD_ID=<thread>` and `--cwd <thread workspace>`; writes are serialised per thread.
- Frontend (`app.tsx`): thread action tab registered with `app.slots.experimental_tab`.
- CLI lookup: setting `cliPath`, else env `PROMPT_STACK_CLI`, else the newest `~/.claude/plugins/cache/*/prompt-stack/*/bin/prompt-stack`, else the copy bundled with this plugin at `claude-plugin/bin/prompt-stack`. With none of these present the panel says to install the prompt-stack Claude Code plugin.
- Setting `stackHome` passes `PROMPT_STACK_HOME` for testing. Leave empty in normal use.

Install: `bb plugin install . --yes`. After edits: `bb plugin build && bb plugin reload prompt-stack`.
