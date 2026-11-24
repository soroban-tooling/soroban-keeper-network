# Documentation site

A static [mdBook](https://rust-lang.github.io/mdBook/) site that organises the
project's Markdown into **Concepts**, **Guides**, **Reference** and
**Operations**.

## Build it

```bash
make docs          # build into docs/site/book/
make docs-serve    # build, serve and watch on http://localhost:3000
```

Both run `docs/site/build.sh`. You need Node.js (18 or later) and mdBook 0.5 or
later (`cargo install mdbook --locked`, or a binary from the
[releases page](https://github.com/rust-lang/mdBook/releases)).

## How it works

The documentation is **not moved**. `docs/*.md` and the per-package READMEs stay
where they are, so `git log --follow` and every existing link keep working.

- [`src/SUMMARY.md`](src/SUMMARY.md) is the navigation and the only place that
  decides which section a page belongs to.
- [`stage.mjs`](stage.mjs) copies the source files into `src/` (gitignored) at
  build time and rewrites relative links: links to other site pages are
  re-pointed inside the site, links to anything else (source code, scripts,
  workflows) become GitHub URLs.
- `mdbook build` renders `src/` into `book/` (gitignored).

## Adding a page

1. Add the Markdown file under `docs/` (or, for a package README, add it to
   `EXTRA` in `stage.mjs`).
2. Add it to the right section of `src/SUMMARY.md`.

The build fails if a staged page is missing from `SUMMARY.md` or `SUMMARY.md`
links to a page that does not exist, so the navigation cannot drift.

## CI

[`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) builds the site
on pull requests that touch the docs and deploys it to GitHub Pages on pushes
to `main`. A maintainer must set Pages > Source to "GitHub Actions" once.
