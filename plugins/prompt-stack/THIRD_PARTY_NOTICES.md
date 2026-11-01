# Third-party notices

Every source below is used under the MIT licence. The licence text appears once at the end, after the copyright line of each source.

## bb plugin registry

The files below are copied from the bb plugin registry (https://github.com/get-bb/bb, `packages/plugin-registry`), added with the shadcn CLI through the `@bb` registry set in `components.json`.

- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/checkbox.tsx`
- `components/ui/coarse-pointer-sizing.ts`
- `components/ui/dialog.tsx`
- `components/ui/icon.tsx`
- `components/ui/input.tsx`
- `components/ui/motion.ts`
- `components/ui/overlay-trigger.ts`
- `components/ui/responsive-overlay.tsx`
- `components/ui/hooks/use-compact-viewport.tsx`
- `components/ui/hooks/use-media-query.ts`
- `components/ui/hooks/use-pointer-coarse.ts`
- `hooks/useBrowserDimmingModal.ts`
- `lib/portal-scope.ts`
- `lib/utils.ts`

## shadcn/ui

The registry components above follow the shadcn/ui component model (https://ui.shadcn.com), configured in `components.json`.

## Prove-it skills (Ray Amjad)

The verifier idea and the `create-prove-it`, `maintain-prove-it` and `audit-prove-it` skills come from Ray Amjad, "Verification is the new code review" (https://github.com/ray-amjad/skills, commit `36dea1e9fd58c527a80244bd147f062516e2c253`). They are vendored verbatim, with their own `LICENSE` and `SOURCE.md`, in the Prompt Stack Claude Code plugin that this panel drives (`claude-plugin/skills/`, a folder of this plugin in BB Overlay).

## Copyright lines and licence text

- bb: Copyright (c) 2026 Michael Yong
- shadcn/ui: Copyright (c) 2023 shadcn
- Ray Amjad's prove-it skills: Copyright (c) 2026 Ray Amjad

    MIT License

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
