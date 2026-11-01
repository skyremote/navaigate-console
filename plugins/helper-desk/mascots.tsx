// Helper Desk avatars. Every agent, subagent, workflow and worktree wears one of nine canvas animations (./avatars),
// picked from its id by hash so it never changes between renders. The lead card wears the NavAIgate N, drawn like the NavMotion
// films' mark (./avatars/nmark), unless the user gives it an animation of its own.
import { Avatar } from "./avatars/Avatar";
import { animationFor, hashId } from "./avatars/assign";
import { animationById, type AnimationId } from "./avatars/animations";
import { useMascotChoice } from "./mascotchoice";
import { N_ID, PALETTE, type MascotState } from "./mascots3d/catalog";
import { NavN } from "./avatars/NavN";

export { PALETTE, hashId };
export type { MascotState };

/** A card colour from its id. Avatars are monochrome; this tints the card chrome, the N's glow and the fresh tick. */
export function colourForId(id: string): string {
  return PALETTE[(hashId(id) >>> 8) % PALETTE.length]!;
}

export function mascotStateFor(state: string): MascotState {
  if (state === "running" || state === "working") return "work";
  if (state === "failed" || state === "interrupted") return "error";
  if (state === "finished") return "done";
  if (state === "waiting" || state === "needs-you") return "wait";
  return "idle";
}

export interface MascotProps {
  seed: string;
  colour: string;
  state: MascotState;
  size?: number;
  fresh?: boolean;
  label?: string;
  /** Forces one animation (or the N), for previews. */
  character?: string;
  /** What this card wears when it has no pick of its own, instead of one from the rotation. Only the N is accepted. */
  automatic?: string;
}

/** An avatar for one agent. `seed` is the agent's id (thread id for a lead). */
export function Mascot(props: MascotProps) {
  const choice = useMascotChoice();
  const { seed, state, size = 32, fresh = false, label } = props;
  const forced = animationById(props.character)?.id;
  const own = animationById(choice.picks[seed])?.id;
  const wearsN = props.character === N_ID || (!forced && !own && props.automatic === N_ID);
  const animation = wearsN ? N_ID : (forced ?? animationFor(seed, { pick: own, set: choice.set }));
  return (
    <span className={`hd-botwrap hd-mode-${fresh ? "fresh" : state}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {fresh && (
        <svg className="hd-tick" viewBox="0 0 7 6" width="12" height="10" shapeRendering="crispEdges" aria-hidden="true">
          {[[6, 0], [5, 1], [4, 2], [0, 2], [1, 3], [3, 3], [2, 4]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="#1f9d55" />)}
        </svg>
      )}
      <span className={`hd-m hd-m-${state}`} data-mascot={animation} style={{ ["--hd-ms" as string]: `${size}px` }}>
        {wearsN ? <NavN seed={seed} state={state} size={size} /> : <Avatar animation={animation as AnimationId} seed={seed} state={state} size={size} />}
      </span>
    </span>
  );
}
