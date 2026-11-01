const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export const ghostButton = `inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${focus}`;

export const outlineButton = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-[13px] text-foreground transition-colors hover:bg-accent sm:min-h-8 ${focus}`;

export const field = `min-h-8 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground ${focus}`;

export const fieldArea = `${field} py-1.5 leading-snug`;

export const pageShell = "mx-auto w-full max-w-[880px] space-y-4 px-7 py-6 text-foreground";

export const pageTitle = "text-[24px] font-medium leading-8";

export const pageLede = "mt-1 text-[13px] leading-5 text-muted-foreground";
