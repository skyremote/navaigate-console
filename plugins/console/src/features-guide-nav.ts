export const FEATURES_GUIDE_PATH = "features";
export const FEATURES_GUIDE_HREF = `/plugins/navaigate-skin/${FEATURES_GUIDE_PATH}`;

/** Go to an app address without a navigation hook: sidebar footer items and commands have none. */
export function goToHref(href: string): void {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}

export function openFeaturesGuide(): void {
  goToHref(FEATURES_GUIDE_HREF);
}
