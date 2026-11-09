// The page: the login, the shell around every view (header, sidebar, theme) and the router between views.

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./app.css";
import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { Shell, use_route, type ShellSection } from "@x-tech-laboratories/x-libs/web/react/shell";
import type { Route } from "@x-tech-laboratories/x-libs/web/router";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, LoginNeeded } from "./api.ts";
import { BuildsView } from "./views/builds.tsx";
import { CacheView, CachesView } from "./views/cache.tsx";
import { closure_title, ClosureView } from "./views/closure.tsx";
import { FlakesView, FlakeView } from "./views/flakes.tsx";
import { FleetRunView } from "./views/fleet.tsx";
import { DeploymentRedirect, host_tabs, HostsView, HostView, tab_labels, type HostTab } from "./views/hosts.tsx";
import { JobsView, JobView } from "./views/jobs.tsx";
import { OverviewView } from "./views/overview.tsx";
import { ProvisionView } from "./views/provision.tsx";

const theme = theme_choice("x-nix-theme");

const sections: ShellSection[] = [
  { id: "", label: "Overview", href: "#/" },
  { id: "flakes", label: "Flakes", href: "#/flakes" },
  { id: "cache", label: "Cache", href: "#/cache" },
  { id: "hosts", label: "Hosts", href: "#/hosts" },
  { id: "jobs", label: "Jobs", href: "#/jobs" },
  { id: "provision", label: "Provision", href: "#/provision" },
];

// ── Routing ──────────────────────────────────────────────────────────────────

// Old addresses whose pages now live under another sidebar section, which they light up.
const parent_sections: Record<string, string> = { builds: "jobs", deployments: "hosts", fleet: "hosts", store: "hosts", boot: "hosts" };

interface Page {
  title: string;
  view: ReactNode;
}

function host_page(name: string, asked: HostTab | null): Page {
  return { title: asked === null ? name : `${tab_labels[asked]} · ${name}`, view: <HostView name={name} asked={asked} /> };
}

function page_for({ parts, query }: Route): Page {
  const [section, id, page] = parts;
  const hosts = { title: "Hosts", view: <HostsView /> };
  if (section === "hosts" && id && page === "closure") {
    const generation = query.get("generation");
    const which = query.get("which") === "target" ? "target" : "current";
    return { title: `${closure_title(generation, which)} · ${id}`, view: <ClosureView host_name={id} generation={generation} which={which} /> };
  }
  if (section === "hosts" && id) return host_page(id, host_tabs.includes(page as HostTab) ? page as HostTab : null);
  if (section === "hosts") return hosts;
  if (section === "flakes" && id) return { title: `Flake · ${id}`, view: <FlakeView id={id} /> };
  if (section === "flakes") return { title: "Flakes", view: <FlakesView /> };
  if (section === "deployments" && id) return { title: id, view: <DeploymentRedirect id={id} page={page} /> };
  if (section === "deployments") return hosts;
  if (section === "fleet" && id && /^\d+$/.test(id)) return { title: `Fleet run ${id}`, view: <FleetRunView id={Number(id)} /> };
  if (section === "fleet") return hosts;
  if (section === "jobs" && id && /^\d+$/.test(id)) return { title: `Job ${id}`, view: <JobView id={Number(id)} /> };
  if (section === "jobs") return { title: "Jobs", view: <JobsView show_evaluations={query.get("evaluations") === "1"} /> };
  if (section === "builds") return { title: "Builds", view: <BuildsView owner={query.get("owner") ?? ""} target={query.get("target") ?? ""} /> };
  if (section === "cache" && id) return { title: `Cache · ${id}`, view: <CacheView id={id} /> };
  if (section === "cache") return { title: "Cache", view: <CachesView /> };
  if ((section === "store" || section === "boot") && id) return host_page(id, section);
  if (section === "store" || section === "boot") return hosts;
  if (section === "provision") return { title: "Provision", view: <ProvisionView /> };
  return { title: "Overview", view: <OverviewView /> };
}

// ── Login ────────────────────────────────────────────────────────────────────

function Login({ on_login }: { on_login: (user_name: string) => void }) {
  const name = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [message, set_message] = useState("");
  const [busy, set_busy] = useState(false);

  useEffect(() => {
    document.title = "Log in · X-Nix";
    name.current?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    set_busy(true);
    set_message("");
    const user_name = name.current!.value;
    try {
      await api("/api/login", "POST", { name: user_name, password: password.current!.value });
      on_login(user_name.trim().toLowerCase());
    } catch (error) {
      set_message(describe_error(error));
      password.current?.select();
      set_busy(false);
    }
  };

  return (
    <form className="login" onSubmit={(event) => void submit(event)}>
      <div className="login-brand"><img src="/icon.svg" alt="" width={96} height={96} /><h1>X-Nix</h1></div>
      <label className="field">
        <span className="field-label">User name</span>
        <input ref={name} type="text" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-label="User name" />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input ref={password} type="password" name="password" autoComplete="current-password" required aria-label="Password" />
      </label>
      <button type="submit" className="accent solid" disabled={busy}>Log in</button>
      <p className="tone-bad" role="alert">{message}</p>
    </form>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

// Whether a session is open, and for whom: checking until the first request answers.
type Session = { state: "checking" } | { state: "login" } | { state: "open"; user: string };

function App() {
  const [session, set_session] = useState<Session>({ state: "checking" });
  const route = use_route();

  useEffect(() => {
    // The first request tells whether a session is still open.
    void api<{ name?: string }>("/api/me").then(
      (me) => set_session({ state: "open", user: me.name ?? "" }),
      (error) => set_session(error instanceof LoginNeeded ? { state: "login" } : { state: "open", user: "" }),
    );
    // A session can lapse while any view is fetching, so a LoginNeeded from anywhere brings the login back.
    const lapsed = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof LoginNeeded)) return;
      event.preventDefault();
      set_session({ state: "login" });
    };
    window.addEventListener("unhandledrejection", lapsed);
    return () => window.removeEventListener("unhandledrejection", lapsed);
  }, []);

  const logged_in = session.state === "open";
  const shown = logged_in ? page_for(route) : null;
  const view_key = `${route.parts.join("/")}?${route.query}`;

  useEffect(() => {
    if (shown) document.title = `${shown.title} · X-Nix`;
  }, [shown?.title, logged_in]);

  const log_out = async () => {
    await api("/api/logout", "POST").catch(() => {});
    set_session({ state: "login" });
  };

  return (
    <Shell
      key={logged_in ? "open" : "closed"}
      brand="X-Nix"
      sections={sections}
      active={parent_sections[route.parts[0] ?? ""] ?? route.parts[0] ?? ""}
      theme={theme}
      user={logged_in ? session.user : null}
      on_logout={() => void log_out()}
      view_key={view_key}
    >
      {session.state === "login" && <Login on_login={(user) => set_session({ state: "open", user })} />}
      {/* A new address draws its view afresh, as each view loads what it shows when it starts. */}
      {shown && <Fragment key={view_key}>{shown.view}</Fragment>}
    </Shell>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
