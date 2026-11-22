// The X-Nix documentation site, built with the X-Libs site framework and published on GitHub Pages.
import { define_site } from "@x-tech-laboratories/x-libs/site/model";

export default define_site({
  title: "X-Nix",
  description: "A web portal for managing NixOS deployments.",
  site: "https://x-tech-laboratories.github.io",
  base: "/X-Nix/",
  content: ".",
  logo: "../resources/icon.svg",
  social: [{ icon: "github", label: "GitHub", href: "https://github.com/x-tech-laboratories/X-Nix" }],
  edit_link: "https://github.com/x-tech-laboratories/X-Nix/edit/main/docs/",
  last_updated: true,
  theme_key: "x-nix-docs-theme",
  css: [
    "@x-tech-laboratories/halon/halon-tokens.css",
    "@x-tech-laboratories/halon/halon.css",
    "@x-tech-laboratories/halon/site.css",
    "@fontsource/noto-sans/400.css",
    "@fontsource/noto-sans/500.css",
    "@fontsource/noto-sans/600.css",
    "@fontsource/noto-sans/700.css",
  ],
  sidebar: [
    { slug: "", label: "Home" },
    { label: "User guide", autogenerate: { directory: "user" } },
    { label: "Developer guide", autogenerate: { directory: "developer" } },
    { slug: "roadmap" },
    { slug: "changelog" },
  ],
});
