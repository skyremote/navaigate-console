# Third-party notices

Every source below is used under the MIT licence. The licence text appears once at the end, after the copyright line of each source. `fleet/owner/third-party-notices.test.ts` fails when a file that carries a T3 Code header, or a file under `fleet/components/ui/`, is missing from these lists.

## T3 Code

Code in the files below is ported from T3 Code (https://github.com/pingdotgg/t3code). Each file keeps the licence header.

- `fleet/owner/editor-link.ts`: per-segment path encoding and the `vscode-remote` `ssh-remote` URL form (from `packages/contracts/src/editor.ts`).

## bb plugin registry

The files below are copied unchanged from the bb plugin registry (https://github.com/get-bb/bb, `packages/plugin-registry`), added with the shadcn CLI through the `@bb` registry set in `fleet/components.json`.

- `fleet/components/ui/button.tsx`
- `fleet/components/ui/card.tsx`
- `fleet/components/ui/checkbox.tsx`
- `fleet/components/ui/coarse-pointer-sizing.ts`
- `fleet/components/ui/dialog.tsx`
- `fleet/components/ui/icon.tsx`
- `fleet/components/ui/input.tsx`
- `fleet/components/ui/motion.ts`
- `fleet/components/ui/overlay-trigger.ts`
- `fleet/components/ui/responsive-overlay.tsx`
- `fleet/components/ui/hooks/use-compact-viewport.tsx`
- `fleet/components/ui/hooks/use-media-query.ts`
- `fleet/components/ui/hooks/use-pointer-coarse.ts`
- `fleet/hooks/useBrowserDimmingModal.ts`
- `fleet/lib/portal-scope.ts`
- `fleet/lib/utils.ts`

## shadcn/ui

The registry components above follow the shadcn/ui component model (https://ui.shadcn.com), configured in `fleet/components.json`.

## Copyright lines and licence text

- T3 Code: Copyright (c) 2026 T3 Tools Inc.
- bb: Copyright (c) 2026 Michael Yong
- shadcn/ui: Copyright (c) 2023 shadcn

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
