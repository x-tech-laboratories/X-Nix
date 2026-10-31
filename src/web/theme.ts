// The light, dark or system theme, kept in this browser and set as data-theme on the page.

export type Theme = "system" | "light" | "dark";

const storage_key = "x-nix-theme";
const listeners = new Set<(theme: Theme) => void>();

export const theme_choice = {
  get(): Theme {
    try {
      const saved = localStorage.getItem(storage_key);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  },

  set(theme: Theme): void {
    try {
      if (theme === "system") localStorage.removeItem(storage_key);
      else localStorage.setItem(storage_key, theme);
    } catch {
      // Without storage the choice lasts until the page is closed.
    }
    apply(theme);
  },

  on_change(listener: (theme: Theme) => void): void {
    listeners.add(listener);
  },
};

export function apply(theme: Theme = theme_choice.get()): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener(theme);
}

// The header's button steps through system, light and dark.
export function next_theme(theme: Theme): Theme {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}
