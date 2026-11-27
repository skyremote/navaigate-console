# Artifacts for BB

The Claude app's Artifacts page, inside BB. One gallery shows your claude.ai artifacts and every page your BB chats have saved. Each card has **Share** and **Install as app**, and both work the way they do in the Claude app.

## What you get

- **An Artifacts page in BB's left rail.** It has tabs for All, Yours, Shared with you and Made in BB, plus search. Cards for HTML pages show a preview picture, and Markdown pages show their first lines.
- **Share.** A page made in BB is published to your claude.ai artifacts, private to you. The link is copied and the artifact opens in the Claude desktop app, or in Chrome if you don't have it. There, Claude's own **Share** button sets who can open it, for example *Anyone with the link*. If you change the page later, Share updates the same artifact, so the link stays the same.
- **Install as app.** This publishes the page first if needed, then opens the artifact in the Claude desktop app. There, click **Share**, then **Install as app**, and confirm. That's Claude's own feature: the artifact becomes a real Mac or Windows app with its own icon and window. It can use Claude and your connectors, asks before doing more on your computer, and updates when the artifact does ([Anthropic's announcement](https://claude.com/resources/articles/install-as-app)). Only the Claude desktop app can install it, so BB takes you straight there.
- **A `bb artifacts` command.** Agents in your BB chats can use it to list, publish and open artifacts.

It adds this one plugin and nothing else. Your other plugins, your theme and your sidebar stay as they are.

## Install

```sh
bb plugin install "git:https://github.com/skyremote/navaigate-console.git@main" --plugin artifacts --yes
```

The **Artifacts** icon then appears in BB's left rail.

## What it needs

- **BB 0.49 or later.**
- **Claude Code 2.1.281 or later, signed in to claude.ai** on a Pro, Max, Ultra, Team or Enterprise plan. Artifacts belong to your claude.ai account, and Claude Code is what publishes and lists them. BB's chats sign in their own way, so Claude Code needs its own sign-in once. If it isn't signed in, the page shows **Sign in to claude.ai**, which opens claude.ai's sign-in page. You can also run `claude auth login` in a terminal.
- **The Claude desktop app for Mac or Windows, version 6.28899 or later**, for Install as app. The first time BB opens a `claude://` link it may ask you to allow it.
- **Google Chrome**, for the preview pictures and for opening pages. Without Chrome, pages open in your default browser and the cards have no previews.

## How it works

- **Where pages come from:** every chat's `artifacts` folder (`<project>/.bb/chats/<chat>/artifacts` and BB's thread storage), plus any folders you add in the plugin's settings. Only `.html`, `.htm` and `.md` files count. A Markdown file is hidden when an HTML file with the same name sits beside it, since it's that page's source.
- **claude.ai artifacts:** the plugin runs your own Claude Code in the background with only its Artifact tool, which is the documented way to [list and publish artifacts](https://code.claude.com/docs/en/artifacts). Each run takes about five seconds and uses a little of your plan's usage. The list refreshes when you open the page, at most every ten minutes, and whenever you press **Refresh**.
- **What Claude Code can touch:** only the Artifact tool, plus reading a private copy of the one page being published. No MCP servers, hooks or settings load, nothing is saved to your chat history, and publishing never edits your files.
- **Updates never throw work away.** If a page has changed since you shared it, Share updates the artifact only when the live version is still exactly what BB last published. If someone changed it on claude.ai, BB stops and tells you. You can then use **Share as a new artifact** from the card's … menu.
- **Who can open a shared artifact** is always set on claude.ai, in the artifact's Share menu. BB never changes it.
- **Installed apps** are managed by Claude: everything you've installed is under File → Apps in the Claude desktop app, which is also where you uninstall.

## Settings

In BB's plugin settings for Artifacts:

- **Extra folders:** other folders whose pages should appear, one full path per line.
- **Claude Code path:** leave this empty unless the page says Claude Code wasn't found.

## Commands

```sh
bb artifacts list [--json]                   # your claude.ai artifacts and BB's saved pages
bb artifacts publish <file> [--new] [--json] # publish or update; --new makes a separate artifact
bb artifacts open <url|file>                 # an artifact in the Claude app, a page in Chrome
```

## Development

```sh
npm install
npm test              # parser and folder-scan tests
npm run typecheck
npm run build         # bb plugin build
bb plugin install .   # or: bb plugin reload artifacts
```
