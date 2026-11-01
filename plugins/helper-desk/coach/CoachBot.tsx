/**
 * The coach's animated avatar, ported from the NavAIgate platform's
 * v2 `bot/CoachBot.tsx` (NavAIgate-2.0-event-baseline at 392148f1), which is itself
 * a React port of the parts of upstream bloub's `BloubBot.vue` a small state-driven face needs.
 * The engine in `./bloub/` is bloub by Jérémy Perret (MIT, see `bloub/LICENSE` and `bloub/README.md`),
 * copied byte for byte.
 *
 * What changed from the platform's file, and why:
 * - Rendering: the platform pushes every frame through React state (`setFrame`). On a slide that is
 *   already running a dozen Motion animations, the deck keeps per-frame React work off the table, so
 *   here the SVG skeleton renders once and each frame is written straight to its attributes (only the
 *   ones that changed). Same engine, same frames, same pixels.
 * - Only the calm states the platform's coach uses are drawn (`coachBotState.ts`: idle, thinking, wide,
 *   wink, notify; alert's tear-drop dot is drawn too). The orbit and comet arcs and the burst particles
 *   behind the body are left out: none of those states are used on the slide.
 * - The two platform-only imports (`motionReduced`, `useReducedMotion`) are replaced by a
 *   `prefers-reduced-motion` check.
 * - `shape` picks the silhouette at rest (any of the customiser's eight, the cloud by default) and morphs
 *   through the engine's own `setShape`; Helper Desk's Mascots tab chooses it for the right-hand coach.
 * - `paper` defaults to bb's `var(--card)` (falling back to `--background`) and the notification badge
 *   is Helper Desk's "needs you" amber. (In the decks these were `--paper` and terra.)
 *
 * Cost: the loop runs only while the face is mounted, on screen and the tab is visible (the
 * IntersectionObserver and `visibilitychange`, as on the platform), at most 60 frames a second while it
 * moves and about 15 once it has settled at rest. `paused` (the presenter's thumbnails) or reduced motion
 * draw one still frame and run no loop.
 *
 * Colour: the body is painted in `currentColor`, so the parent's CSS colour drives it. The opaque
 * "paper" behind the body is needed because the eyes are real holes punched through the body.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'

import { BotEngine, type BotFrame, type Look } from './bloub/engine'
import { EXPRESSION_BY_ID, type BotExpression, type ExpressionId } from './bloub/expressions'
import { DEMI_VIEWBOX, RAYON } from './bloub/repere'
import { SHAPE_BY_ID, type ShapeId } from './bloub/skins'
import { POSES, type StateId } from './bloub/states'

export type { Look } from './bloub/engine'
export type { StateId } from './bloub/states'

const R = RAYON
const VB = DEMI_VIEWBOX

/** The customiser shape chosen on the platform: `'nuage'` is the cloud. */
const COACH_SHAPE: ShapeId = 'nuage'
/** `'surpris'`: the wide, round eyes chosen in the customiser, at rest. */
const COACH_EXPRESSION: ExpressionId = 'surpris'

/** The shortest gap between drawn frames, in ms: 60 a second while moving, about 15 at rest. */
const FRAME_MS = 1000 / 60
const REST_FRAME_MS = 1000 / 15
/** Slack for rAF jitter, so a 60 Hz display is not throttled to 30. */
const JITTER_MS = 2
/** Seconds after entering the rest state before the loop slows (the morph into it runs at full rate). */
const REST_AFTER = 1
/** Decorative dots drawn at most at once (thinking shows three, and up to six while it morphs). */
const DOT_POOL = 8

/** Imperative gaze for callers that steer the eyes many times a second (no React render per move). */
export interface CoachControl {
  look(look: Look | null, morph?: number): void
}

export interface CoachBotProps {
  /** Rendered width and height, in px. Square; the viewBox is always `VB*2 x VB*2`. */
  size?: number
  /** A catalogue state id from `bloub/states.ts`. Changing it morphs, never jumps. */
  state?: StateId
  /** Where the face looks (the engine's own `setLook`). `null` hands the gaze back; absent, untouched. A `Look` must carry `spin`. */
  look?: Look | null
  /** Hold one still frame (the state's most readable pose) and run no loop. */
  paused?: boolean
  /** The opaque colour behind the body (the eyes are holes in it). */
  paper?: string
  /** The badge colour. */
  badge?: string
  /** A rim of `paper` round the body, in viewBox units (the deck's addition, so the ink body reads on a dark photo). */
  rim?: number
  /** The silhouette at rest. Defaults to the cloud; changing it morphs. */
  shape?: ShapeId
  label?: string
  className?: string
  style?: CSSProperties
  /** bb addition: receives an imperative gaze handle while mounted (the companion steers the eyes with it). */
  control?: { current: CoachControl | null }
}

function stillFrame(state: StateId, radii: number[] | null, expr: BotExpression | null, t: number): BotFrame {
  return new BotEngine(R, state, radii, expr).sample(t)
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

interface Parts {
  backing: SVGPathElement
  body: SVGGElement
  maskBody: SVGPathElement
  eyes: SVGPathElement[]
  notch: SVGCircleElement
  dots: SVGCircleElement[]
  tears: SVGPathElement[]
  notif: SVGCircleElement
}

/** Writes one frame into the skeleton, touching only attributes whose value changed. */
function makeDrawer() {
  const cache = new WeakMap<Element, Record<string, string>>()
  const set = (el: Element, name: string, value: string | number) => {
    const v = String(value)
    let c = cache.get(el)
    if (!c) cache.set(el, (c = {}))
    if (c[name] === v) return
    c[name] = v
    el.setAttribute(name, v)
  }
  const show = (el: Element, on: boolean) => set(el, 'display', on ? 'inline' : 'none')
  return (p: Parts, f: BotFrame) => {
    set(p.backing, 'd', f.bodyPath)
    set(p.maskBody, 'd', f.bodyPath)
    set(p.body, 'opacity', f.bodyAlpha)
    for (let i = 0; i < p.eyes.length; i++) {
      const e = f.eyes[i]
      const el = p.eyes[i]
      show(el, !!e)
      if (!e) continue
      set(el, 'd', e.d)
      set(el, 'transform', e.matrix)
      set(el, 'opacity', e.alpha)
    }
    for (let i = 0; i < DOT_POOL; i++) {
      const d = f.dots[i]
      const circle = p.dots[i]
      const tear = p.tears[i]
      show(circle, !!d && !d.d)
      show(tear, !!d && !!d.d)
      if (!d) continue
      const fill = d.color ?? 'currentColor'
      // Upstream fades a receding dot toward the page colour; as on the platform, depth folds into opacity.
      const opacity = d.opacity * (d.depth ?? 1)
      if (d.d) {
        set(tear, 'd', d.d)
        set(tear, 'transform', `translate(${d.x} ${d.y}) rotate(${d.rot ?? 0}) scale(${R})`)
        set(tear, 'fill', fill)
        set(tear, 'opacity', opacity)
      } else {
        set(circle, 'cx', d.x)
        set(circle, 'cy', d.y)
        set(circle, 'r', d.r)
        set(circle, 'fill', fill)
        set(circle, 'opacity', opacity)
      }
    }
    show(p.notif, !!f.notif)
    show(p.notch, !!f.notch)
    if (f.notif) {
      set(p.notif, 'cx', f.notif.x)
      set(p.notif, 'cy', f.notif.y)
      set(p.notif, 'r', f.notif.r)
    }
    if (f.notch) {
      set(p.notch, 'cx', f.notch.x)
      set(p.notch, 'cy', f.notch.y)
      set(p.notch, 'r', f.notch.r)
    }
  }
}

export function CoachBot({ size = 104, state = 'idle', look, paused = false, shape = COACH_SHAPE, paper = 'var(--card, var(--background, #fff))', badge = '#e08a00', rim = 0, label, className, style, control }: CoachBotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const maskId = `coach-bot-mask-${uid}`

  const radii = useMemo(() => SHAPE_BY_ID.get(shape)?.radii ?? null, [shape])
  const expr = useMemo(() => EXPRESSION_BY_ID.get(COACH_EXPRESSION) ?? null, [])

  // One engine per mounted face, built once.
  const engineRef = useRef<BotEngine | null>(null)
  if (!engineRef.current) engineRef.current = new BotEngine(R, state, radii, expr)
  const engine = engineRef.current

  const svgRef = useRef<SVGSVGElement | null>(null)
  const parts = useRef<Parts | null>(null)
  const draw = useMemo(makeDrawer, [])
  /** Seconds since mount; only the running loop advances it. */
  const clockRef = useRef(0)
  /** The clock when the state or the gaze last changed: the loop slows once the face has settled at rest. */
  const enteredRef = useRef(0)
  const loopingRef = useRef(false)

  // Collect the skeleton's nodes once.
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const q = <T extends Element>(sel: string) => Array.from(svg.querySelectorAll<T>(sel))
    parts.current = {
      backing: svg.querySelector('[data-k="backing"]') as SVGPathElement,
      body: svg.querySelector('[data-k="body"]') as SVGGElement,
      maskBody: svg.querySelector('[data-k="mask-body"]') as SVGPathElement,
      eyes: q<SVGPathElement>('[data-k="eye"]'),
      notch: svg.querySelector('[data-k="notch"]') as SVGCircleElement,
      dots: q<SVGCircleElement>('[data-k="dot"]'),
      tears: q<SVGPathElement>('[data-k="tear"]'),
      notif: svg.querySelector('[data-k="notif"]') as SVGCircleElement,
    }
    draw(parts.current, engine.sample(POSES[state] ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const still = paused || reducedMotion()

  // The loop: only while mounted, on screen and the document is visible.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    if (still) {
      loopingRef.current = false
      if (parts.current) draw(parts.current, stillFrame(state, radii, expr, POSES[state] ?? 0))
      return
    }
    let raf = 0
    let last = 0
    let drawn = 0
    let onScreen = true
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick)
      // A tab hidden then shown again resumes without a jump.
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0
      last = ms
      clockRef.current += dt
      const resting = engine.state === 'idle' && clockRef.current - enteredRef.current > REST_AFTER
      if (drawn && ms - drawn < (resting ? REST_FRAME_MS : FRAME_MS) - JITTER_MS) return
      drawn = ms
      if (parts.current) draw(parts.current, engine.sample(clockRef.current))
    }
    const start = () => {
      if (raf) return
      last = 0
      drawn = 0
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      if (!raf) return
      cancelAnimationFrame(raf)
      raf = 0
    }
    const sync = () => (onScreen && document.visibilityState === 'visible' ? start() : stop())
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting)
            sync()
          })
        : null
    io?.observe(svg)
    loopingRef.current = true
    if (parts.current) draw(parts.current, engine.sample(clockRef.current))
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      loopingRef.current = false
      stop()
      io?.disconnect()
      document.removeEventListener('visibilitychange', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still])

  // bb addition: a chosen silhouette morphs in through the engine's own setShape.
  useEffect(() => {
    engine.setShape(radii, clockRef.current)
    enteredRef.current = clockRef.current
  }, [engine, radii])

  // State changes go through the engine's own morph, never a jump.
  useEffect(() => {
    if (engine.state !== state) {
      engine.setState(state, clockRef.current)
      enteredRef.current = clockRef.current
    }
    if (!loopingRef.current && parts.current) draw(parts.current, stillFrame(state, radii, expr, POSES[state] ?? 0))
  }, [state, engine, radii, expr, draw])

  // The gaze, through the engine's own timed setter, once a caller has asked for one.
  const lookedRef = useRef(false)
  useEffect(() => {
    if (look === undefined && !lookedRef.current) return
    lookedRef.current = true
    engine.setLook(look ?? null, clockRef.current)
    enteredRef.current = clockRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, look?.yaw, look?.pitch, look?.mix, look?.spin, look?.wander, look === null])

  // bb addition: the imperative gaze. Resetting `enteredRef` keeps the loop at full rate while the eyes move.
  useEffect(() => {
    if (!control) return
    control.current = {
      look: (l, morph) => {
        engine.setLook(l, clockRef.current, morph)
        enteredRef.current = clockRef.current
      },
    }
    return () => {
      control.current = null
    }
  }, [control, engine])

  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }
  const pool = Array.from({ length: DOT_POOL }, (_, i) => i)

  return (
    <svg ref={svgRef} className={className} style={style} data-bot-state={state} data-bot-shape={shape} width={size} height={size} viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`} focusable="false" {...a11y}>
      <defs>
        {/* The eyes are real holes cut through the body, cropped by the silhouette as they near the edge. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB} y={-VB} width={VB * 2} height={VB * 2}>
          <path data-k="mask-body" fill="#fff" />
          <path data-k="eye" fill="#000" />
          <path data-k="eye" fill="#000" />
          <circle data-k="notch" fill="#000" display="none" />
        </mask>
      </defs>
      <g data-k="body">
        {/* opaque backing, exactly the body's shape, under the body itself */}
        <path data-k="backing" style={{ fill: paper, stroke: rim ? paper : 'none', strokeWidth: rim * 2, strokeLinejoin: 'round' }} />
        <g mask={`url(#${maskId})`}>
          <rect x={-VB} y={-VB} width={VB * 2} height={VB * 2} fill="currentColor" />
        </g>
      </g>
      <g>
        {pool.map((i) => (
          <circle key={`d${i}`} data-k="dot" display="none" />
        ))}
        {pool.map((i) => (
          <path key={`t${i}`} data-k="tear" display="none" />
        ))}
      </g>
      <circle data-k="notif" display="none" style={{ fill: badge }} />
    </svg>
  )
}

export default CoachBot
