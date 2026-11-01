import { goToHref } from "./features-guide-nav";
import { SETUP_HREF } from "./setup-model";

export function openSetup(): void {
  goToHref(SETUP_HREF);
}
