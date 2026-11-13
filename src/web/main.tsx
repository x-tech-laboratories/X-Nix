// The page: the sign-in, the shell around every view (header, sidebar, theme), the server's change feed and the router between views.

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./app.css";
import { follow_changes } from "@x-tech-laboratories/x-libs/web/events";
import { AccountView, UsersView } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { Shell, use_route, type ShellSection } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import type { Route } from "@x-tech-laboratories/x-libs/web/router";
import type { Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";
import { Fragment, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { accounts, changes } from "./api.ts";
import { BuildsView } from "./views/builds.tsx";
import { CacheView, CachesView } from "./views/cache.tsx";
import { closure_title, ClosureView } from "./views/closure.tsx";
import { FlakesView, FlakeView } from "./views/flakes.tsx";
import { FleetRunView } from "./views/fleet.tsx";
import { DeploymentRedirect, host_tabs, HostsView, HostView, tab_labels, type HostTab } from "./views/hosts.tsx";
import { JobsView, JobView } from "./views/jobs.tsx";
import { OverviewView } from "./views/overview.tsx";
import { ProvisionView } from "./views/provision.tsx";
import { SettingsView } from "./views/settings.tsx";

const theme = theme_choice("x-nix-theme");

const sections: ShellSection[] = [
  { id: "", label: "Overview", href: "#/" },
  { id: "flakes", label: "Flakes", href: "#/flakes" },
  { id: "cache", label: "Cache", href: "#/cache" },
  { id: "hosts", label: "Hosts", href: "#/hosts" },
  { id: "jobs", label: "Jobs", href: "#/jobs" },
  { id: "provision", label: "Provision", href: "#/provision" },
  { id: "users", label: "Users", href: "#/users" },
];

const role_text = { viewer: "Reads everything; changes nothing.", admin: "Also builds, deploys, reboots and manages users." };

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

function page_for({ parts, query }: Route, me: Me): Page {
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
  if (section === "account") return { title: "Your account", view: <AccountView client={accounts} role_text={role_text} /> };
  if (section === "users") return { title: "Users", view: <UsersView client={accounts} me={me} role_text={role_text} /> };
  if (section === "provision") return { title: "Provision", view: <ProvisionView /> };
  if (section === "settings" || section === "backups") return { title: "Settings", view: <SettingsView me={me} theme={theme} /> };
  return { title: "Overview", view: <OverviewView /> };
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { account, refresh, sign_out } = use_account(accounts);
  const route = use_route();

  const me = account.state === "signed_in" ? account.me : null;
  const logged_in = me !== null;

  // The server's change feed needs a session, so it opens on signing in and closes on signing out.
  useEffect(() => {
    if (!logged_in) return;
    const feed = follow_changes("/api/events", { watch: changes });
    return () => feed.close();
  }, [logged_in]);

  const shown = me ? page_for(route, me) : null;
  const view_key = `${route.parts.join("/")}?${route.query}`;

  useEffect(() => {
    if (shown) document.title = `${shown.title} · X-Nix`;
  }, [shown?.title, logged_in]);

  return (
    <Shell
      key={logged_in ? "open" : "closed"}
      brand="X-Nix"
      sections={sections.filter((section) => section.id !== "users" || me?.role === "admin")}
      active={parent_sections[route.parts[0] ?? ""] ?? route.parts[0] ?? ""}
      theme={theme}
      user={me?.name ?? null}
      user_href="#/account"
      settings={{ href: "#/settings", active: route.parts[0] === "settings" || route.parts[0] === "backups" }}
      on_logout={() => void sign_out()}
      view_key={view_key}
    >
      {account.state === "signed_out" && <SignInForm client={accounts} title="X-Nix" icon="/icon.svg" on_signed_in={refresh} />}
      {/* A new address draws its view afresh, as each view loads what it shows when it starts. */}
      {shown && <Fragment key={view_key}>{shown.view}</Fragment>}
    </Shell>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
