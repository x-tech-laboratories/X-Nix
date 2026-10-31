// The sections still to be filled, each saying what it will hold.

import { h } from "../dom.ts";
import { empty } from "../ui.ts";
import type { View } from "./shared.ts";

interface Upcoming {
  title: string;
  summary: string;
}

export const upcoming_sections: Record<string, Upcoming> = {
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
