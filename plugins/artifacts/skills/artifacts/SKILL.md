---
name: artifacts
description: Save pages where the Artifacts page shows them, and publish an HTML or Markdown page as a claude.ai artifact with `bb artifacts publish`. Use when the user asks to share, publish or "make an artifact" of a page, or wants a link to a page you made.
---

# Artifacts

The Artifacts plugin shows every `.html`, `.htm` and `.md` page saved in a chat's `artifacts` folder, next to the user's claude.ai artifacts. From there the user can Share a page or Install it as an app.

## Save pages where the user will find them

Save a finished page (report, deck, explainer, dashboard) in this chat's `artifacts` folder. Give it a real `<title>`, or a `# Heading` for Markdown: that is the name on its card.

## Publish when the user asks

Publish only when the user asks to share, publish or make an artifact:

```sh
bb artifacts publish "<full path to the file>"
```

It prints the claude.ai link. The artifact is private to the user until they open it and use claude.ai's **Share** menu, so tell them that when you give the link. Publishing the same file again updates the same artifact and keeps the link. `--new` makes a separate artifact.

Page rules (claude.ai serves artifacts under a strict policy): one self-contained file, scripts only from cdnjs, unpkg, jsDelivr or the Tailwind and jQuery CDNs, fonts from Google Fonts, images inlined as data URIs, and 16 MiB at most.

## Other commands

- `bb artifacts list` lists the user's claude.ai artifacts and the pages BB chats saved.
- `bb artifacts open "<link or file>"` opens an artifact in the Claude app (or Chrome), or a page in Chrome.
- To make an artifact a desktop app, the user opens it in the Claude desktop app and chooses Share → Install as app. The Install as app button on the Artifacts page takes them there.

If publishing fails with "isn't signed in", the user needs to press **Sign in to claude.ai** on the Artifacts page once.
