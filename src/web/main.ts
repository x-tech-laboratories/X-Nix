// The page: the shell around every view (header, sidebar, theme) and the router between views.

import { current_route } from "./router.ts";
import { apply, next_theme, theme_choice, type Theme } from "./theme.ts";
import { deployment_view, deployments_view } from "./views/deployments.ts";
import { job_view, jobs_view } from "./views/jobs.ts";
import { overview_view } from "./views/overview.ts";
import { upcoming_sections, upcoming_view } from "./views/pages.ts";
import type { View } from "./views/shared.ts";
import "./halon-tokens.css";
import "./halon.css";

const main = document.querySelector<HTMLElement>("main")!;
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const scrim = document.querySelector<HTMLElement>("#scrim")!;
const menu = document.querySelector<HTMLButtonElement>("#menu")!;

let current: View | null = null;
let first_view = true;

// ── Routing ──────────────────────────────────────────────────────────────────

function view_for(parts: string[]): View {
  const [section, id] = parts;
  if (section === "deployments" && id) return deployment_view(id);
  if (section === "deployments") return deployments_view();
  if (section === "jobs" && id && /^\d+$/.test(id)) return job_view(Number(id));
  if (section === "jobs") return jobs_view();
  if (section !== undefined && section in upcoming_sections) return upcoming_view(section);
  return overview_view();
}

function show(): void {
  current?.dispose?.();
  const route = current_route();
  current = view_for(route.parts);
  main.replaceChildren(current.root);
  document.title = `${current.title} · X-Nix`;
  for (const item of sidebar.querySelectorAll<HTMLAnchorElement>("a[data-section]")) {
    const active = item.dataset.section === (route.parts[0] ?? "");
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  close_menu();
  // Moving focus to the new page tells a screen reader the view changed, but not on the first load.
  if (!first_view) main.focus({ preventScroll: true });
  first_view = false;
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", show);

// ── Menu ─────────────────────────────────────────────────────────────────────

function close_menu(): void {
  document.body.classList.remove("menu-open");
  menu.setAttribute("aria-expanded", "false");
  scrim.hidden = true;
}

menu.addEventListener("click", () => {
  const open = !document.body.classList.contains("menu-open");
  document.body.classList.toggle("menu-open", open);
  menu.setAttribute("aria-expanded", String(open));
  scrim.hidden = !open;
  if (open) sidebar.querySelector<HTMLElement>("a")?.focus();
});
scrim.addEventListener("click", close_menu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("menu-open")) {
    close_menu();
    menu.focus();
  }
});

// ── Theme ────────────────────────────────────────────────────────────────────

const theme_button = document.querySelector<HTMLButtonElement>("#theme")!;
const theme_labels: Record<Theme, [icon: string, text: string]> = { system: ["◐", "Theme: system"], light: ["☀", "Theme: light"], dark: ["☾", "Theme: dark"] };

function show_theme(theme: Theme): void {
  const [icon, text] = theme_labels[theme];
  theme_button.textContent = icon;
  theme_button.title = `${text} (click to change)`;
  theme_button.setAttribute("aria-label", `${text}, click to change`);
}

theme_choice.on_change(show_theme);
theme_button.addEventListener("click", () => theme_choice.set(next_theme(theme_choice.get())));
apply();

// ── Start ────────────────────────────────────────────────────────────────────

show();
