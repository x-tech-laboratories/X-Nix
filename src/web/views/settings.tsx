// The Settings page: the theme kept in this browser, what the server runs, how AI clients reach it, and its backups.

import type { Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Facts, PageHeading, SettingRow, SettingsPage, type SettingsCategory } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import type { Theme, ThemeChoice } from "@x-tech-laboratories/x-libs/web/theme";
import { useEffect, useState } from "react";
import { api, backups, type Health } from "../api.ts";

const theme_choices: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// ── Sections ─────────────────────────────────────────────────────────────────

function ThemeSetting({ theme }: { theme: ThemeChoice }) {
  const [chosen, set_chosen] = useState(theme.get());
  useEffect(() => theme.on_change(set_chosen), [theme]);

  return (
    <SettingRow label="Theme" hint="System follows the light or dark choice of your desktop.">
      <Segmented label="Theme" choices={theme_choices} value={chosen} on_change={(value) => theme.set(value)} />
    </SettingRow>
  );
}

function About() {
  const health = use_resource(() => api<Health>("/api/health"), []);

  return (
    <Loaded resource={health}>
      {(found) => <Facts rows={[["Version", found.version], ["Server", found.server_name], ["Started", <Age epoch={found.started_epoch} />]]} />}
    </Loaded>
  );
}

function AiClients() {
  return (
    <>
      <SettingRow label="MCP address" hint="Add this to an AI client as a streamable HTTP server.">
        <code>{`${window.location.origin}/api/mcp`}</code>
      </SettingRow>
      <SettingRow label="Token" hint="Send a token from your account as a Bearer header; a read-only token lets the client look but not act.">
        <a href="#/account">Make a token</a>
      </SettingRow>
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

// A restore restarts the server, so the page loads again once it answers.
export function SettingsView({ me, theme }: { me: Me; theme: ThemeChoice }) {
  const categories: SettingsCategory[] = [
    { heading: "General", sections: [{ id: "appearance", heading: "Appearance", content: <ThemeSetting theme={theme} /> }] },
    {
      heading: "Server",
      sections: [
        { id: "about", heading: "About", content: <About /> },
        { id: "ai-clients", heading: "AI clients", hint: "X-Nix offers its calls as MCP tools, run as the signed-in user.", content: <AiClients /> },
        ...(me.role === "admin"
          ? [{
            id: "backups",
            heading: "Backups",
            hint: "Copies of the state database: accounts, jobs and readings. A restore restarts the server.",
            content: <BackupSettings device={backups} data_name="accounts, jobs and readings" on_restored={() => setTimeout(() => window.location.reload(), 3000)} />,
          }]
          : []),
      ],
    },
  ];

  return (
    <>
      <PageHeading title="Settings" />
      <SettingsPage categories={categories} />
    </>
  );
}
