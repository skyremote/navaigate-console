# Third-party notices

## T3 Code

`review-tour.ts` adapts the hunk parsing, excerpt clamping and "files nobody placed" rule from T3 Code (https://github.com/pingdotgg/t3code), `apps/server/src/pullRequest/pullRequestReviewGuideNormalize.ts` and `packages/shared/src/gitPatchPath.ts`, and keeps its licence header. No other source file in this plugin is copied from T3 Code. The Delivery view links to it, and lists the files every NavAIgate repository copied from it (`src/source-notices.ts`). The core repository's `THIRD_PARTY_NOTICES.md` and the Fleet repository's `fleet/THIRD_PARTY_NOTICES.md` carry the licence text for their files.

    MIT License

    Copyright (c) 2026 T3 Tools Inc.

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

## shadcn/ui

The component sources in `components/ui/` were generated with the shadcn/ui CLI (see `components.json`) and then edited, used under the MIT licence (https://ui.shadcn.com):

    MIT License

    Copyright (c) 2023 shadcn

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

## OpenUI

The Console does not bundle OpenUI. It lists "OpenUI blocks in chat" in its feature guide (`features/map.json`), and the feature itself is rendered by the `inline-vis` plugin that ships with the bb core build, which uses OpenUI (https://github.com/thesysdev/openui, homepage https://openui.com) under the MIT licence. The licence text below is the one published in `@openuidev/react-lang` 1.0.2 and `@openuidev/lang-core` 1.0.2 (both carry the same file):

    The MIT License (MIT)

    Copyright (c) 2011-2024 Thesys Inc.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## unslop

The styling choices of the Delivery, Home and sidebar views (spacing scale, colour tokens, icon use, plain copy) were reviewed against the unslop method by Damir Sokolovsky (https://heydamir.design/unslop, https://x.com/heydamir), which is licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). No unslop text or code is copied into this plugin; `tests/native-unslop-shots.test.tsx` only renders preview pages for that review. The author and licence were confirmed on 1 November 2026 against the upstream `LICENSE` (CC BY 4.0) and `CITATION.cff` (author Damir Sokolovsky, repository https://github.com/heydamir/unslop).

## Confirmed upstream licences

T3 Code (https://github.com/pingdotgg/t3code) and shadcn/ui (https://github.com/shadcn-ui/ui) were checked against their published `LICENSE` and `LICENSE.md` on 1 November 2026: the holders are "T3 Tools Inc." (2026) and "shadcn" (2023), both MIT, matching the texts above. 21st.dev is not used by this plugin and is not credited.
