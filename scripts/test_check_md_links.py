"""Unit tests for scripts/check-md-links.py. Run: python3 -m unittest scripts/test_check_md_links.py"""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("check_md_links", Path(__file__).with_name("check-md-links.py"))
cml = importlib.util.module_from_spec(_spec)
sys.modules["check_md_links"] = cml
_spec.loader.exec_module(cml)


class SlugTests(unittest.TestCase):
    def test_github_slug_rules(self):
        cases = {
            "Hello World": "hello-world",
            "`code` and **bold**": "code-and-bold",
            "What's new? (v2.0)": "whats-new-v20",
            "Q&A": "qa",
            "snake_case name": "snake_case-name",
            "[Link text](http://x.y)": "link-text",
            "Step 1 — install": "step-1--install",
        }
        for heading, slug in cases.items():
            self.assertEqual(cml.heading_text_to_slug(heading), slug, heading)

    def test_duplicate_headings_get_numeric_suffix(self):
        anchors = cml.collect_anchors("# Intro\n\n## Intro\n\n## Intro\n")
        self.assertEqual(anchors, {"intro", "intro-1", "intro-2"})

    def test_headings_inside_code_fences_are_ignored(self):
        anchors = cml.collect_anchors("# Real\n\n```\n# Not a heading\n```\n")
        self.assertEqual(anchors, {"real"})

    def test_explicit_html_anchor_is_collected(self):
        self.assertIn("custom", cml.collect_anchors('<a id="custom"></a>\n'))


class CheckerTests(unittest.TestCase):
    def run_check(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for name, body in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body, encoding="utf-8")
            paths = sorted(p for p in root.rglob("*.md"))
            problems = cml.Checker(root).check_all_relative(paths)
            return [(p.link.source.relative_to(root).as_posix(), p.link.target, p.reason) for p in problems]

    def test_valid_links_pass(self):
        problems = self.run_check(
            {
                "README.md": "# Top\n\nSee [guide](docs/guide.md#setup), [dir](docs), [self](#top).\n",
                "docs/guide.md": "## Setup\n\nBack to [root](../README.md) and [abs](/README.md#top).\n",
            }
        )
        self.assertEqual(problems, [])

    def test_missing_file_fails(self):
        problems = self.run_check({"README.md": "[x](missing.md)\n"})
        self.assertEqual(len(problems), 1)
        self.assertIn("not found", problems[0][2])

    def test_missing_anchor_fails(self):
        problems = self.run_check({"README.md": "[x](a.md#nope)\n", "a.md": "# Real\n"})
        self.assertEqual(len(problems), 1)
        self.assertIn("#nope", problems[0][2])

    def test_missing_same_file_anchor_fails(self):
        problems = self.run_check({"README.md": "# Top\n[x](#gone)\n"})
        self.assertEqual(len(problems), 1)

    def test_wrong_case_fails(self):
        problems = self.run_check({"README.md": "[x](Docs/Guide.md)\n", "docs/guide.md": "# G\n"})
        self.assertEqual(len(problems), 1)

    def test_escaping_the_repo_fails(self):
        problems = self.run_check({"a/README.md": "[x](../../outside.md)\n"})
        self.assertEqual(len(problems), 1)
        self.assertIn("outside", problems[0][2])

    def test_links_in_code_are_ignored(self):
        body = "`[x](nope.md)`\n\n```\n[y](nope2.md)\n```\n"
        self.assertEqual(self.run_check({"README.md": body}), [])

    def test_external_and_mail_links_are_not_checked_in_relative_mode(self):
        body = "[a](https://example.invalid/x) [b](mailto:a@b.c) <https://example.invalid/y>\n"
        self.assertEqual(self.run_check({"README.md": body}), [])

    def test_reference_style_links_are_checked(self):
        problems = self.run_check({"README.md": "[x][r]\n\n[r]: gone.md\n"})
        self.assertEqual(len(problems), 1)

    def test_line_anchor_on_code_file_is_not_checked(self):
        problems = self.run_check({"README.md": "[x](src/lib.rs#L10)\n", "src/lib.rs": "fn main() {}\n"})
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
