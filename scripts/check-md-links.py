#!/usr/bin/env python3
"""Check links in the repository's Markdown files.

Default mode (run on every PR) checks *relative* links only:

  * the target file or directory exists (case-sensitively, so a link that
    works on a case-insensitive laptop but breaks on Linux CI is caught);
  * for links to Markdown files (or same-file `#anchor` links), the anchor
    matches a heading or an explicit `<a id>` / `<a name>` in the target,
    using GitHub's heading-slug rules.

`--external` mode checks http(s) links instead. It is meant for a scheduled
job, not for PRs, because third-party sites flake and rate-limit.

Only the Python standard library is used so the check runs anywhere with no
install step.

Exit status: 0 when clean, 1 when any broken link is found, 2 on usage error.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# Directories that never hold hand-written docs.
SKIP_DIRS = {".git", "node_modules", "target", "dist", "build", ".next", "out", "vendor"}

FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$")
SETEXT_RE = re.compile(r"^\s{0,3}(=+|-+)\s*$")
INLINE_CODE_RE = re.compile(r"(`+)(.+?)\1")
# [text](target "title") and ![alt](target). The target may be <wrapped>.
INLINE_LINK_RE = re.compile(r"!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)")
# [label]: target
REF_DEF_RE = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
AUTOLINK_RE = re.compile(r"<(https?://[^>\s]+)>")
HTML_ID_RE = re.compile(r"""<[a-zA-Z][^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']""")
HTML_HREF_RE = re.compile(r"""<(?:a|img)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["']""", re.I)

EXTERNAL_RE = re.compile(r"^https?://", re.I)
SKIP_SCHEMES = ("mailto:", "tel:", "data:", "javascript:", "ftp:")


@dataclass(frozen=True)
class Link:
    source: Path
    line: int
    target: str


@dataclass(frozen=True)
class Problem:
    link: Link
    reason: str

    def render(self, root: Path) -> str:
        rel = self.link.source.relative_to(root).as_posix()
        return f"{rel}:{self.link.line}: {self.link.target} -> {self.reason}"


# ── Markdown parsing ─────────────────────────────────────────────────────────


def strip_code_spans(text: str) -> str:
    """Blank out inline code so `[x](y)` inside backticks is not a link."""
    return INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), text)


def iter_lines(text: str):
    """Yield (line_number, line, in_fence) for every line."""
    fence = None
    for number, line in enumerate(text.splitlines(), start=1):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker[0], len(marker)
                yield number, line, True
                continue
            if marker[0] == fence[0] and len(marker) >= fence[1]:
                fence = None
                yield number, line, True
                continue
        yield number, line, fence is not None


def heading_text_to_slug(text: str) -> str:
    """GitHub's heading anchor algorithm (without the duplicate suffix)."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links/images -> label
    text = re.sub(r"<[^>]+>", "", text)  # inline HTML
    text = text.replace("`", "")
    text = re.sub(r"[*~]+", "", text)  # emphasis / strike markers
    text = re.sub(r"(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])", "", text)  # _emphasis_
    text = text.strip().lower()
    out = []
    for char in text:
        if char in (" ", "\t"):
            out.append("-")
        elif char == "-" or char == "_" or char.isalnum():
            out.append(char)
        # everything else (punctuation, emoji, symbols) is dropped
    return "".join(out)


def collect_anchors(text: str) -> set[str]:
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    previous = ""
    for _, line, in_fence in iter_lines(text):
        if in_fence:
            previous = ""
            continue
        slug_source = None
        heading = HEADING_RE.match(line)
        if heading:
            slug_source = heading.group(2)
        elif SETEXT_RE.match(line) and previous.strip():
            slug_source = previous
        if slug_source is not None:
            slug = heading_text_to_slug(slug_source)
            seen = counts.get(slug, 0)
            counts[slug] = seen + 1
            anchors.add(slug if seen == 0 else f"{slug}-{seen}")
        for html in HTML_ID_RE.finditer(line):
            anchors.add(html.group(1))
        previous = line
    return anchors


def extract_links(path: Path, text: str) -> list[Link]:
    links: list[Link] = []
    for number, line, in_fence in iter_lines(text):
        if in_fence:
            continue
        clean = strip_code_spans(line)
        targets = [m.group(1) for m in INLINE_LINK_RE.finditer(clean)]
        ref = REF_DEF_RE.match(clean)
        if ref:
            targets.append(ref.group(1))
        targets += [m.group(1) for m in AUTOLINK_RE.finditer(clean)]
        targets += [m.group(1) for m in HTML_HREF_RE.finditer(clean)]
        for raw in targets:
            target = raw.strip()
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1].strip()
            if target:
                links.append(Link(path, number, target))
    return links


# ── File discovery ───────────────────────────────────────────────────────────


def find_markdown(root: Path) -> list[Path]:
    """Tracked Markdown files when inside a git checkout, else a directory walk."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", "*.md"],
            check=True,
            capture_output=True,
        ).stdout.decode("utf-8")
        files = [root / name for name in out.split("\0") if name]
        return sorted(f for f in files if f.is_file() and not (set(f.relative_to(root).parts) & SKIP_DIRS))
    except (OSError, subprocess.CalledProcessError):
        found = []
        for current, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            found += [Path(current) / n for n in names if n.endswith(".md")]
        return sorted(found)


def exists_exact_case(root: Path, path: Path) -> bool:
    """True if `path` exists and every component matches in exact case."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return path.exists()
    current = root
    for part in rel.parts:
        if part in ("", "."):
            continue
        try:
            names = os.listdir(current)
        except OSError:
            return False
        if part not in names:
            return False
        current = current / part
    return True


# ── Checking ─────────────────────────────────────────────────────────────────


class Checker:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self._anchor_cache: dict[Path, set[str]] = {}

    def anchors_for(self, path: Path) -> set[str]:
        if path not in self._anchor_cache:
            text = path.read_text(encoding="utf-8", errors="replace")
            self._anchor_cache[path] = collect_anchors(text)
        return self._anchor_cache[path]

    def check_relative(self, link: Link) -> Problem | None:
        target = link.target
        if EXTERNAL_RE.match(target) or target.lower().startswith(SKIP_SCHEMES) or target.startswith("//"):
            return None
        parsed = urllib.parse.urlsplit(target)
        raw_path = urllib.parse.unquote(parsed.path)
        fragment = urllib.parse.unquote(parsed.fragment)

        if raw_path == "":
            destination = link.source
        elif raw_path.startswith("/"):
            destination = self.root / raw_path.lstrip("/")  # repo-root relative, as on GitHub
        else:
            destination = link.source.parent / raw_path
        destination = Path(os.path.normpath(destination))

        try:
            destination.relative_to(self.root)
        except ValueError:
            return Problem(link, "points outside the repository")
        if not exists_exact_case(self.root, destination):
            return Problem(link, "file or directory not found")

        if fragment and destination.is_file() and destination.suffix.lower() == ".md":
            # GitHub line anchors (#L10, #L10-L20) apply to code, not Markdown.
            if fragment not in self.anchors_for(destination):
                where = "this file" if destination == link.source else destination.relative_to(self.root).as_posix()
                return Problem(link, f"anchor '#{fragment}' not found in {where}")
        return None

    def check_all_relative(self, files: list[Path]) -> list[Problem]:
        problems = []
        for path in files:
            text = path.read_text(encoding="utf-8", errors="replace")
            for link in extract_links(path, text):
                problem = self.check_relative(link)
                if problem:
                    problems.append(problem)
        return problems


def check_external_url(url: str, timeout: float, retries: int = 2) -> str | None:
    """Return a failure reason, or None when the URL is reachable."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; markdown-link-check; +docs)"}
    last = "unknown error"
    for attempt in range(retries + 1):
        for method in ("HEAD", "GET"):
            request = urllib.request.Request(url, method=method, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    if response.status < 400:
                        return None
                    last = f"HTTP {response.status}"
            except urllib.error.HTTPError as err:
                last = f"HTTP {err.code}"
                # Rate limiting and bot walls are not evidence the link is dead.
                if err.code in (401, 403, 429):
                    return None
                if err.code in (404, 410):
                    if method == "GET":
                        return last
                    continue  # some servers reject HEAD; retry with GET
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                last = f"{type(err).__name__}: {getattr(err, 'reason', err)}"
                break
    return last


def check_external(files: list[Path], root: Path, timeout: float, workers: int) -> list[Problem]:
    by_url: dict[str, list[Link]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for link in extract_links(path, text):
            if EXTERNAL_RE.match(link.target):
                url = urllib.parse.urldefrag(link.target)[0]
                by_url.setdefault(url, []).append(link)

    problems: list[Problem] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(check_external_url, url, timeout): url for url in by_url}
        for future in concurrent.futures.as_completed(futures):
            reason = future.result()
            if reason:
                problems += [Problem(link, reason) for link in by_url[futures[future]]]
    return sorted(problems, key=lambda p: (str(p.link.source), p.link.line))


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="Markdown files to check (default: every tracked *.md)")
    parser.add_argument("--root", default=".", help="repository root (default: current directory)")
    parser.add_argument("--external", action="store_true", help="check http(s) links instead of relative links")
    parser.add_argument("--timeout", type=float, default=15.0, help="per-request timeout for --external")
    parser.add_argument("--workers", type=int, default=8, help="parallel requests for --external")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    files = [Path(p).resolve() for p in args.paths] if args.paths else find_markdown(root)
    if not files:
        print("No Markdown files found.", file=sys.stderr)
        return 2

    if args.external:
        problems = check_external(files, root, args.timeout, args.workers)
        kind = "external"
    else:
        problems = Checker(root).check_all_relative(files)
        kind = "relative"

    for problem in problems:
        # GitHub turns this into an inline annotation when run in Actions.
        rel = problem.link.source.relative_to(root).as_posix()
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::error file={rel},line={problem.link.line}::{problem.link.target} -> {problem.reason}")
        else:
            print(problem.render(root))

    print(f"Checked {len(files)} Markdown file(s); {len(problems)} broken {kind} link(s).")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
