# Third-party notices

Every source below is used under the MIT licence. The licence text appears once at the end, after the copyright line of each source. `tests/third-party-notices.test.ts` fails when a vendored file is missing from these lists.

## bloub

The files below are copied byte for byte from bloub by Jérémy Perret (https://github.com/jeremy-prt/bloub, commit `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`). The licence text is in `coach/bloub/LICENSE` and the provenance in `coach/bloub/README.md`.

- `helper-desk/coach/bloub/decor.ts`
- `helper-desk/coach/bloub/engine.ts`
- `helper-desk/coach/bloub/expressions.ts`
- `helper-desk/coach/bloub/eyefit.ts`
- `helper-desk/coach/bloub/face.ts`
- `helper-desk/coach/bloub/math.ts`
- `helper-desk/coach/bloub/profiles.ts`
- `helper-desk/coach/bloub/repere.ts`
- `helper-desk/coach/bloub/shape.ts`
- `helper-desk/coach/bloub/skins.ts`
- `helper-desk/coach/bloub/states.ts`

`helper-desk/coach/CoachBot.tsx` is a React port of the NavAIgate platform's own coach avatar, which drew on bloub's `BloubBot.vue`. It keeps the bloub attribution in its header.

## T3 Code

No file in Helper Desk is copied from T3 Code.

## bb plugin registry

The files below are copied unchanged from the bb plugin registry (https://github.com/get-bb/bb, `packages/plugin-registry`), added with the shadcn CLI through the `@bb` registry set in `helper-desk/components.json`.

- `helper-desk/components/ui/button.tsx`
- `helper-desk/components/ui/card.tsx`
- `helper-desk/components/ui/checkbox.tsx`
- `helper-desk/components/ui/coarse-pointer-sizing.ts`
- `helper-desk/components/ui/dialog.tsx`
- `helper-desk/components/ui/icon.tsx`
- `helper-desk/components/ui/input.tsx`
- `helper-desk/components/ui/motion.ts`
- `helper-desk/components/ui/overlay-trigger.ts`
- `helper-desk/components/ui/responsive-overlay.tsx`
- `helper-desk/components/ui/hooks/use-compact-viewport.tsx`
- `helper-desk/components/ui/hooks/use-media-query.ts`
- `helper-desk/components/ui/hooks/use-pointer-coarse.ts`
- `helper-desk/hooks/useBrowserDimmingModal.ts`
- `helper-desk/lib/portal-scope.ts`
- `helper-desk/lib/utils.ts`

## shadcn/ui

The registry components above follow the shadcn/ui component model (https://ui.shadcn.com), configured in `helper-desk/components.json`.

## 21st.dev: Set of animations

The nine avatar animations in `helper-desk/avatars/animations.ts` are ported and de-minified from "Set of animations" by larsen66, a public community component on 21st.dev (https://21st.dev/community/components/larsen66/set-of-animations-4/default, MIT licence): sphere scan, crystalline refraction, sonar sweep, helix scanner, interconnecting waves, cylindrical analysis, voxel matrix morph, phased array emitter and crystalline cube refraction. The geometry and motion are the original's. Helper Desk rewrote them as pure functions of time that take one ink colour and a size, replaced the fixed white with the theme colour, and enlarged the dots at small sizes. The component page publishes no separate copyright line, so the credit below names the author.

## Copyright lines and licence text

- bloub: Copyright (c) 2026 Jérémy Perret
- bb: Copyright (c) 2026 Michael Yong
- shadcn/ui: Copyright (c) 2023 shadcn
- 21st.dev "Set of animations": Copyright (c) larsen66 (no year or holder line is published on the component page)

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
