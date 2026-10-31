// The page: the login, the shell around every view (header, sidebar, theme) and the router between views.

import { api, LoginNeeded } from "./api.ts";
import { h } from "./dom.ts";
import { current_route } from "./router.ts";
import { apply, next_theme, theme_choice, type Theme } from "./theme.ts";
import { boot_view, boots_view } from "./views/boot.ts";
import { builds_view } from "./views/builds.ts";
import { cache_view, caches_view } from "./views/cache.ts";
import { deployment_view, deployments_view } from "./views/deployments.ts";
import { job_view, jobs_view } from "./views/jobs.ts";
import { overview_view } from "./views/overview.ts";
import { provision_view } from "./views/provision.ts";
import { store_view, stores_view } from "./views/store.ts";
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
  if (section === "builds") return builds_view();
  if (section === "cache" && id) return cache_view(id);
  if (section === "cache") return caches_view();
  if (section === "store" && id) return store_view(id);
  if (section === "store") return stores_view();
  if (section === "boot" && id) return boot_view(id);
  if (section === "boot") return boots_view();
  if (section === "provision") return provision_view();
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

window.addEventListener("hashchange", () => {
  if (!document.body.classList.contains("logged-out")) show();
});

// A session can lapse while any view is fetching, so a LoginNeeded from anywhere brings the login back.
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason instanceof LoginNeeded) {
    event.preventDefault();
    show_login();
  }
});

// ── Login ────────────────────────────────────────────────────────────────────

function show_login(): void {
  current?.dispose?.();
  current = null;
  document.body.classList.add("logged-out");
  document.title = "Log in · X-Nix";
  const password = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
  const message = h("p", { class: "tone-bad", role: "alert" });
  const submit = h("button", { type: "submit", class: "accent solid" }, "Log in");
  const form = h("form", { class: "login", onsubmit: async (event: Event) => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = "";
    try {
      await api("/api/login", "POST", { password: password.value });
      start();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
      password.select();
      submit.disabled = false;
    }
  } },
    h("h1", {}, "X-Nix"),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), password),
    submit, message);
  main.replaceChildren(form);
  password.focus();
}

function start(): void {
  document.body.classList.remove("logged-out");
  first_view = true;
  show();
}

document.querySelector("#logout")!.addEventListener("click", async () => {
  await api("/api/logout", "POST").catch(() => {});
  show_login();
});

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

// The first request tells whether a session is still open.
void api("/api/me").then(start, (error) => {
  if (error instanceof LoginNeeded) show_login();
  else start();
});
