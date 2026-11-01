// Reading the feature picker from components and plain functions.
//
// Until the server has answered AND no profile was cached from the last session,
// every feature reads as on ("show while loading"): the private edition must never
// flash a thinner window, and the community defaults are only a placeholder then.
// A profile cached from the last session is used at once, so a reload does not flicker.
import { createElement, Fragment, type ComponentType, type FunctionComponent, type ReactNode } from "react";
import { getPassedProbes, usePassedProbes } from "./core-probes";
import { isFeatureEnabled, type Probes } from "./features-enabled";
import { getProfileState, useProfileState, type ProfileState } from "./use-profile";

function resolveOn(state: ProfileState, id: string, probes: Probes): boolean {
  if (!state.loaded && state.source === "defaults") return true;
  return isFeatureEnabled(state.profile, id, probes);
}

/** Whether a feature is on right now, for code that is not a component (commands, handlers). */
export function featureNow(id: string): boolean {
  return resolveOn(getProfileState(), id, getPassedProbes());
}

/** Whether a feature is on; re-renders when the profile or the probes change. */
export function useFeature(id: string): boolean {
  return resolveOn(useProfileState(), id, usePassedProbes());
}

/** Draws its children only while the feature is on. */
export function FeatureGate({ id, children, fallback = null }: { id: string; children: ReactNode; fallback?: ReactNode }) {
  return useFeature(id) ? createElement(Fragment, null, children) : fallback;
}

/** Wraps a component so it draws nothing while the feature is off. Hooks inside it do not run then. */
export function gated<P extends object>(id: string, Component: ComponentType<P>): FunctionComponent<P> {
  const Gated = (props: P) => (useFeature(id) ? createElement(Component, props) : null);
  Gated.displayName = `Gated(${id})`;
  return Gated;
}

/** Whether to register a sidebar page, settings section or footer item at plugin load. Reads the cached profile, so a first-ever load registers everything. */
export function registerAtLoad(id: string): boolean {
  return featureNow(id);
}
