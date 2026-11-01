// Light/dark toggle for the sidebar footer, beside Settings, Remote access,
// Provider usage and Report a bug. bb keeps the per-client mode in the
// localStorage atom "bb.theme" ("system" | "light" | "dark"); we write it and
// fire a storage event so bb's own store updates live, exactly as if it had
// been changed in Settings, Appearance.
const KEY = "bb.theme";

export function toggleMode() {
  const isDark = document.documentElement.classList.contains("dark");
  const next = isDark ? "light" : "dark";
  const oldValue = window.localStorage.getItem(KEY);
  const newValue = JSON.stringify(next);
  window.localStorage.setItem(KEY, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue, newValue, storageArea: window.localStorage, url: window.location.href }));
  // Belt and braces: if bb's store did not pick it up, flip the class directly.
  window.setTimeout(() => {
    if (document.documentElement.classList.contains("dark") !== (next === "dark")) {
      document.documentElement.classList.toggle("dark", next === "dark");
    }
  }, 80);
}
