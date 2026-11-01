# Notes for maintainers

## Why Projects & Sections is pinned to 0.6.19

Projects & Sections (`project-folders`, by VKirill) gives the rail its folders and "Move to folder". From 0.6.20 on, its `vk-requires.json` lists two required functions, `experimental_vkSessionPolicy` and `experimental_vkContextContributions`, that only VKirill's own build of bb has. Standard bb (checked on 0.45) has neither, but bb still offers those releases to anyone whose install follows a version range, so a routine `bb plugin update` can leave folders broken.

So we pin to the tag `v0.6.19`, the last release that runs on standard bb. bb treats an exact git tag as pinned: `bb plugin outdated` shows it as `pinned` and `bb plugin update --all` leaves it alone.

The installer uses `git:https://github.com/VKirill/bb-plugin-project-folders.git@v0.6.19` for fresh Pro-preset installs. The Simple preset does not install this companion. Disabled plugins stay disabled and existing 1.11 Pro installations do not gain absent optional companions.

Older installer versions removed and reinstalled Projects & Sections and claimed all data was retained. That is no longer a safe assumption: current BB describes plugin removal as deleting settings, secrets and schedules. **The installer (1.11 and 1.12) never runs plugin remove.** It leaves an incompatible existing source alone by default. The explicit `--pin-folders` option attempts an in-place source installation, without first removing the existing plugin, and reports failure without uninstalling. Do not reinstate an automatic remove/downgrade flow.

## When to lift the pin

Lift it when either of these is true:

1. A newer release of Projects & Sections has no `vk-requires.json`, or its `required` list is empty, so it runs on standard bb again.
2. Standard bb ships the functions that `vk-requires.json` requires.

To check:

```sh
git clone --depth 1 https://github.com/VKirill/bb-plugin-project-folders.git /tmp/pf-check
cat /tmp/pf-check/vk-requires.json        # look at "required"
```

For the second case, search the installed bb for the names in `required`. On macOS that is `grep -rl experimental_vkSessionPolicy /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist`. No match means bb doesn't have them yet.

## How to lift it

Change the pin everywhere it appears, in one release:

- `install.sh`: `PF_VERSION` (and decide whether `folders_existing` should still warn about releases from 0.6.20 to the new one)
- `plugins/workspace/src/folders.ts`: `PROJECT_FOLDERS_INSTALL`
- `README.md` and `INSTALL.md`: the install-by-hand line and the note under it
- `docs/index.html`: the install line (BB Overlay only)

Then test the installer on a throwaway bb (below) from nothing, from the old pin, and from a range install, and mirror the change to the other edition (bb-overlay and navaigate-workspace ship the same installer).

## Testing the installer on a throwaway bb

bb reads its data directory and ports from the environment, so a second server can run next to your own without touching it. On macOS:

```sh
D=/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app
E=/Applications/bb.app/Contents/MacOS/bb
mkdir -p /tmp/bb-clean/data
run() { env -i HOME="$HOME" PATH="$PATH" USER="$USER" ELECTRON_RUN_AS_NODE=1 NODE_ENV=production \
  BB_DATA_DIR=/tmp/bb-clean/data BB_SERVER_PORT=39886 BB_HOST_DAEMON_PORT=39887 "$@"; }
run "$E" "$D/server/dist/index.js" > /tmp/bb-clean/server.log 2>&1 &
# The host daemon needs a one-time enrolment key, which the server issues to loopback callers.
R=$(curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:39886/internal/hosts/enroll-key)
printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["hostId"],end="")' > /tmp/bb-clean/data/host-id
K=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["enrollKey"])')
run BB_SERVER_URL=http://127.0.0.1:39886 BB_HOST_ENROLL_KEY="$K" BB_CLI_DIR="$D/host-daemon/dist" BB_BRIDGE_DIR="$D/host-daemon/dist" "$E" "$D/host-daemon/dist/daemon-bundle.mjs" > /tmp/bb-clean/daemon.log 2>&1 &

# Point the CLI and the installer at it. Unset BB_PROJECT_ID and BB_THREAD_ID if you run this inside a bb chat.
export BB_SERVER_URL=http://127.0.0.1:39886
bb status          # "Data dir: /tmp/bb-clean/data"
bash install.sh
```

Stop both processes and delete `/tmp/bb-clean` when you're done.

## Cutting a release (1.12)

The release plugins are copied in from their own source branches, not edited here.

1. Commit everything in the source worktrees. `scripts/sync-release.sh` refuses to run while a source has uncommitted changes to tracked files (untracked files are ignored), and says which.
2. Run `scripts/sync-release.sh` (or `--only console,fleet` for some). For each of `plugins/console`, `fleet`, `helper-desk`, `navmotion-skin` and `prompt-stack` it copies the tracked files at the source branch HEAD (`rsync --delete`, limited to that folder, never `node_modules` or `dist`), puts the overlay's `LICENSE` and `NOTICE` back, and writes `RELEASE_SOURCES.json` with the folder, plugin id, source repository, branch and commit. For Prompt Stack it also vendors the Claude Code half into `plugins/prompt-stack/claude-plugin/` from `navaigate-team-plugins` and adds `install-hook.sh` (from `scripts/prompt-stack-install-hook.sh`). After copying, the script runs one small rewrite on the vendored Prompt Stack copy only (`neutralise_prompt_stack` in the script): the author in `.claude-plugin/plugin.json` becomes NavAIgate, and the personal "voice" entry in `stack.json` becomes a neutral "Your voice" entry that points at the reader's own voice skill. It gives the same result every time it runs, and the source repository is never edited. `--check` only tests that the sources are clean. The source worktrees are looked up under `/tmp/bbwt` (set `CR_BBWT` to change that).
3. Do not edit synced folders by hand. A fix goes into the source branch and the script is run again. Each plugin keeps its own `THIRD_PARTY_NOTICES.md`.
4. Run the installer tests (`python3 -m unittest tests.test_installer_navigation`, which fake bb and need no real bb) and, in `plugins/onboarding`, `npx vitest run` and `npx tsc --noEmit`. Build the guide with `bb plugin build` if you changed it.
5. Run the leak scan over the whole worktree before tagging.

### How the 1.12 installer decides what to do

- **Mode.** A fresh install, an existing Console (a `navaigate-skin` whose source is this repository) and `--console` all mean the Console. An existing `navaigate-simple` or `navaigate-workspace` install without `--console` is kept in the 1.11 way, including `--edition simple|pro` switching between those two. A `navaigate-skin` from any other source is left alone in every case.
- **Preset.** The installer runs `bb plugin config navaigate-skin set preset simple|pro` only when it installs the Console in that run. It never sets it on a Console that was already there. The Console's Setup screen reads it as the first choice.
- **Switching with `--console`.** Same order as the 1.11 edition switch: save the old look (`~/.config/bb-overlay/before-console`), install, reload, enable if disabled, then appearance, then disable the old cores, then configure. Any failure restores the old values and stops before the next step. There is no uninstall in this path.
- **The guide.** `bb-overlay-guide` gets `edition console` for Console installs. The Console tour is anchored only on the Console's `data-tour="console-setup"`, `console-home`, `console-rail`, `console-features` and `console-fleet` attributes; if the Console renames one, the step falls back to its plain explanation and the guide's tests need the new name.
- **Claude Code settings.** `install.sh` never writes `~/.claude/settings.json`. Only the opt-in `install-hook.sh` does, after a backup.
