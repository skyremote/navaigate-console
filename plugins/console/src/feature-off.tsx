// What a page shows when its feature is switched off, and the gate that decides.
// A sidebar page cannot be hidden from inside the plugin once it is registered, so
// the page says plainly that it is off and how to turn it on.
import { createElement, type ComponentType } from "react";
import { featureById } from "./features-enabled";
import { openSetup } from "./setup-nav";
import { useFeature } from "./use-feature";

export function FeatureOff({ id }: { id: string }) {
  const name = featureById(id)?.name ?? "This feature";
  return (
    <div className="m-6 max-w-[520px] rounded-[14px] border border-border bg-card px-5 py-4" data-nav-part="feature-off" data-feature-off={id}>
      <div className="text-[14px] font-medium text-foreground">{name} is switched off</div>
      <p className="mt-1 text-[13px] text-muted-foreground">Turn it on in setup, under Features. Nothing is lost while it is off.</p>
      <button type="button" onClick={() => openSetup()} className="mt-3 inline-flex min-h-8 items-center rounded-md border border-border px-3 text-[13px] font-medium text-foreground hover:border-foreground">Open setup</button>
    </div>
  );
}

/** A page body that shows the off notice while the feature is off. */
export function pageGate<P extends object>(id: string, Component: ComponentType<P>): ComponentType<P> {
  const Page = (props: P) => (useFeature(id) ? createElement(Component, props) : createElement(FeatureOff, { id }));
  Page.displayName = `PageGate(${id})`;
  return Page;
}
