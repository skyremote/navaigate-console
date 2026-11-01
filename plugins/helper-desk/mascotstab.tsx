// The Mascots tab: which animations the cards rotate through, a large live preview of any of them, and the
// right-hand mascot (an animation, or the coach with its shape and colour).
import { useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { CoachBot } from "./coach/CoachBot";
import { COLORS, SHAPES, type ColorId, type ShapeId } from "./coach/bloub/skins";
import { ANIMATIONS, ANIMATION_IDS, animationById, type AnimationId } from "./avatars/animations";
import { Avatar } from "./avatars/Avatar";
import { clearPicks, coachColourStyle, resetChoices, setCoachCharacter, setCoachColour, setCoachShape, setDefaultSet, useMascotChoice } from "./mascotchoice";
import { Mascot } from "./mascots";
import { N_ID, PALETTE, statesFor, type MascotState } from "./mascots3d/catalog";

const ALL: readonly string[] = ANIMATION_IDS;

const SHAPE_NAME: Record<ShapeId, string> = { cercle: "Circle", galet: "Pebble", squircle: "Squircle", capsule: "Capsule", triangle: "Triangle", hexagone: "Hexagon", nuage: "Cloud", goutte: "Drop" };
const COLOUR_NAME: Record<ColorId, string> = { encre: "Ink", brun: "Brown", rouge: "Red", orange: "Orange", ambre: "Amber", vert: "Green", turquoise: "Teal", bleu: "Blue", violet: "Violet", rose: "Pink", gris: "Grey", creme: "Cream" };
const STATE_NAME: Record<MascotState, string> = { work: "Working", idle: "Idle", wait: "Waiting for you", done: "Done", error: "Error" };
const WORDS = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** The animations the unpicked cards rotate through now: the stored set, or all nine when it is empty or stale. */
export function effectiveSet(stored: readonly string[], all: readonly string[] = ALL): string[] {
  const known = all.filter((id) => stored.includes(id));
  return known.length ? known : [...all];
}

/** Flips one animation in the set. The last one cannot be removed, and a full set is stored as empty. */
export function toggleInSet(stored: readonly string[], id: string, all: readonly string[] = ALL): string[] {
  const now = effectiveSet(stored, all);
  const next = now.includes(id) ? now.filter((x) => x !== id) : all.filter((x) => x === id || now.includes(x));
  if (next.length === 0) return [...stored];
  const others = stored.filter((x) => !all.includes(x));
  return next.length === all.length ? others : [...others, ...next];
}

const PREVIEW_STATES: readonly MascotState[] = ["work", "wait", "idle", "done", "error"];

function Stage({ id, onShow }: { id: string; onShow: (id: string) => void }) {
  const [state, setState] = useState<MascotState>("work");
  const isN = id === N_ID;
  const name = isN ? "NavAIgate N" : (animationById(id)?.name ?? id);
  const about = isN ? "The lead card's own mascot, the NavAIgate N drawn like the mark in our films." : animationById(id)?.about;
  const states = isN ? statesFor(N_ID) : PREVIEW_STATES;
  const shown = states.includes(state) ? state : "idle";
  return (
    <section className="hd-msec">
      <h3 className="hd-msec-h">Live preview</h3>
      <p className="hd-msec-p">
        The lead card wears the NavAIgate N unless you pick another mascot for it from the card's own menu.{" "}
        <button type="button" className="hd-link" data-character={N_ID} aria-pressed={isN} onClick={() => onShow(N_ID)}>Show the NavAIgate N</button>
      </p>
      <div className="hd-mstage">
        {isN ? (
          <Mascot seed={`stage:${id}`} character={id} colour={PALETTE[1]!} state={shown} size={96} label={`${name}, ${STATE_NAME[shown]}`} />
        ) : (
          <span className="hd-botwrap"><span className="hd-m" style={{ ["--hd-ms" as string]: "180px" }}><Avatar animation={id as AnimationId} seed={`stage:${id}`} state={shown} size={180} label={`${name}, ${STATE_NAME[shown]}`} /></span></span>
        )}
        <div>
          <strong>{name}</strong>
          <span>{about}</span>
        </div>
      </div>
      <div className="hd-mstates" role="group" aria-label="Preview state">
        {states.map((s) => (
          <button key={s} type="button" data-state={s} aria-pressed={shown === s} onClick={() => setState(s)}>{STATE_NAME[s]}</button>
        ))}
      </div>
    </section>
  );
}

function Preview({ id, size }: { id: string; size: number }) {
  return (
    <span className="hd-botwrap">
      <span className="hd-m" style={{ ["--hd-ms" as string]: `${size}px` }}>
        <Avatar animation={id as AnimationId} seed={`tile:${id}`} state="idle" size={size} preview />
      </span>
    </span>
  );
}

export function MascotsTab() {
  const choice = useMascotChoice();
  const { values } = useSettings();
  const companionOn = values?.companion !== false;
  const set = effectiveSet(choice.set);
  const [stageId, setStageId] = useState<string>(ANIMATION_IDS[0]!);
  const shape: ShapeId = choice.shape ?? "nuage";
  const own = Object.keys(choice.picks).length;
  const untouched = choice.shape === null && choice.colour === null && choice.coach === null;
  const coachAnim = animationById(choice.coach);
  const coachIsN = choice.coach === N_ID;
  return (
    <div className="hd-mtab">
      <section className="hd-msec">
        <h3 className="hd-msec-h">Default mascots</h3>
        <p className="hd-msec-p">Cards without a mascot of their own rotate through these. Pick a mascot for one card by pressing it.</p>
        <div className="hd-mtab-grid hd-mtab-grid3" role="group" aria-label="Default mascots">
          {ANIMATIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="hd-mchoose-tile"
              data-character={a.id}
              aria-pressed={set.includes(a.id)}
              onClick={() => setDefaultSet(toggleInSet(choice.set, a.id))}
              onPointerEnter={() => setStageId(a.id)}
              onFocus={() => setStageId(a.id)}
            >
              <Preview id={a.id} size={40} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
        <div className="hd-msec-foot">
          <span>{set.length === ALL.length ? `All ${WORDS[ALL.length]} in rotation` : `${set.length} of ${WORDS[ALL.length]} in rotation`}</span>
          <button type="button" className="hd-link" disabled={set.length === ALL.length} onClick={() => setDefaultSet([])}>Use all {WORDS[ALL.length]}</button>
        </div>
      </section>

      <Stage id={stageId} onShow={setStageId} />

      <section className="hd-msec">
        <h3 className="hd-msec-h">Right-hand mascot</h3>
        <p className="hd-msec-p">The mascot that floats along the right edge of bb.{companionOn ? "" : " It is switched off in Helper Desk settings, so this shows how it will look once you turn it on."}</p>
        <div className="hd-mpreview" style={coachColourStyle(choice.colour)}>
          {coachIsN ? (
            <Mascot seed="coach" character={N_ID} colour={PALETTE[1]!} state="idle" size={64} label="The right-hand mascot, NavAIgate N" />
          ) : coachAnim ? (
            <span className="hd-botwrap"><span className="hd-m" style={{ ["--hd-ms" as string]: "64px" }}><Avatar animation={coachAnim.id} seed="coach" state="idle" size={64} label={`The right-hand mascot, ${coachAnim.name}`} /></span></span>
          ) : (
            <CoachBot size={64} state="idle" shape={shape} label={`The right-hand mascot, ${SHAPE_NAME[shape]}`} />
          )}
          <span>{coachIsN ? "NavAIgate N" : coachAnim ? coachAnim.name : SHAPE_NAME[shape]}{!coachAnim && !coachIsN && (choice.colour ? `, ${COLOUR_NAME[choice.colour]}` : ", theme colour")}</span>
        </div>
        <div className="hd-mtab-grid hd-mtab-grid3" role="group" aria-label="Right-hand mascot character">
          <button type="button" className="hd-mchoose-tile" data-coach="" aria-pressed={choice.coach === null} onClick={() => setCoachCharacter(null)} style={coachColourStyle(choice.colour)}>
            <CoachBot size={34} state="idle" shape={shape} paused />
            <span>Coach</span>
          </button>
          {ANIMATIONS.map((a) => (
            <button key={a.id} type="button" className="hd-mchoose-tile" data-coach={a.id} aria-pressed={choice.coach === a.id} onClick={() => setCoachCharacter(a.id)} onPointerEnter={() => setStageId(a.id)} onFocus={() => setStageId(a.id)}>
              <Preview id={a.id} size={34} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
        {!coachAnim && !coachIsN && (
          <>
            <div className="hd-mtab-grid" role="group" aria-label="Right-hand mascot shape">
              {SHAPES.map((s) => (
                <button key={s.id} type="button" className="hd-mchoose-tile" data-shape={s.id} aria-pressed={shape === s.id} onClick={() => setCoachShape(s.id)} style={coachColourStyle(choice.colour)}>
                  <CoachBot size={34} state="idle" shape={s.id} paused />
                  <span>{SHAPE_NAME[s.id]}</span>
                </button>
              ))}
            </div>
            <div className="hd-mswatches" role="group" aria-label="Right-hand mascot colour">
              <button type="button" className="hd-mswatch hd-mswatch-theme" data-theme="" aria-pressed={choice.colour === null} title="Follow the theme" onClick={() => setCoachColour(null)}>Theme</button>
              {COLORS.map((c) => (
                <button key={c.id} type="button" className="hd-mswatch" data-colour={c.id} aria-label={COLOUR_NAME[c.id]} aria-pressed={choice.colour === c.id} title={COLOUR_NAME[c.id]} style={{ background: c.hex }} onClick={() => setCoachColour(c.id)} />
              ))}
            </div>
          </>
        )}
        <div className="hd-msec-foot">
          <span />
          <button type="button" className="hd-link" disabled={untouched} onClick={() => { setCoachCharacter(null); setCoachShape(null); setCoachColour(null); }}>Back to the cloud</button>
        </div>
      </section>

      <section className="hd-msec">
        <h3 className="hd-msec-h">Cards with their own mascot</h3>
        <div className="hd-msec-foot">
          <span>{own === 0 ? "No card has its own mascot." : `${own} ${own === 1 ? "card has" : "cards have"} their own mascot.`}</span>
          <button type="button" className="hd-link" disabled={own === 0} onClick={clearPicks}>Clear card choices</button>
        </div>
        <div className="hd-msec-foot">
          <span>Everything on this tab</span>
          <button type="button" className="hd-link" onClick={resetChoices}>Reset all</button>
        </div>
      </section>
    </div>
  );
}
