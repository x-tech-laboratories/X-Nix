// The sections still to be filled, each saying what it will hold.

import { h } from "../dom.ts";
import { empty } from "../ui.ts";
import type { View } from "./shared.ts";

interface Upcoming {
  title: string;
  summary: string;
}

export const upcoming_sections: Record<string, Upcoming> = {
  deployments: {
    title: "Deployments",
    summary: "Each host's running system against what its flake builds, with update, build, switch and reboot.",
  },
  jobs: {
    title: "Jobs",
    summary: "Every evaluation, update, build, switch and reboot, with its output.",
  },
  store: {
    title: "Store",
    summary: "The Nix store's size, every profile's generations, and garbage collection.",
  },
  cache: {
    title: "Cache",
    summary: "Whether each closure is built from the flake's latest revision and pushed to the Attic cache.",
  },
  boot: {
    title: "Boot",
    summary: "Boot entries, the next boot's entry, and whether a reboot is needed.",
  },
};

export function upcoming_view(section_id: string): View {
  const upcoming = upcoming_sections[section_id];
  return {
    title: upcoming.title,
    root: h("div", { class: "page" },
      h("h1", {}, upcoming.title),
      h("p", { class: "muted" }, upcoming.summary),
      empty("Not here yet.", "This section is being brought across from X-Monitor."),
    ),
  };
}
