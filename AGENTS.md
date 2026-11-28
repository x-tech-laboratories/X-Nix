# Instructions for AI agents

## X-Tech standards

- Follow the [Application Standard](https://x-tech-laboratories.github.io/standards/application/) and the
  [Design Guidelines](https://x-tech-laboratories.github.io/standards/design/), whose source is `src/content/docs/standards/`
  in [x-tech-laboratories.github.io](https://github.com/x-tech-laboratories/x-tech-laboratories.github.io). Ask before
  changing either, since a change applies to every X-app.
- Use [X-App](https://github.com/x-tech-laboratories/X-App) and Halon ([X-Themes](https://github.com/x-tech-laboratories/X-Themes))
  before writing your own code: check the module table in the X-App README first.
- A feature another app could use belongs in X-App, or Halon for styling, with tests and a README row. If that is out
  of reach, add it to the candidates in X-App's `docs/TODO.md`.

## Roadmap and changelog

- Every commit adds its own line to `docs/changelog.md` under **Unreleased**, beneath a heading for the day it was
  made: the commit's subject line.
- `docs/roadmap.md` lists what is not built yet. When an item ships, the same commit removes it from the roadmap and
  describes it in the user or developer guide.
