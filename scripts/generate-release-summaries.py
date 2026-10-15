#!/usr/bin/env python3
"""Generate role-based release summaries (release_summaries seed rows) with the claude CLI.

For each persona (admin/developer/architect) x product ('' = general, agentforce, apex, ...),
selects the relevant release-note chunks from the ingest CSV (TOC section + keyword relevance),
packs them into a prompt budget, and pipes them to `claude -p` together with the previous
release's summary for the same persona/product as a structure/tone reference.

Usage:
  python3 -I scripts/generate-release-summaries.py --release winter-27 \
      --chunks /tmp/sfada/release-chunks.csv --toc /tmp/sfada/rn-raw/winter-27/_toc.html \
      --examples db/init/seed-release-summaries.csv.gz --example-release summer-26 \
      --out /tmp/sfada/winter27-summaries.csv [--work-dir /tmp/sfada/summaries-work] [--jobs 3] [--dry-run]

Outputs are cached per persona/product in --work-dir, so re-runs only generate what's missing.
"""
import argparse
import csv
import gzip
import html
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

csv.field_size_limit(sys.maxsize)

PERSONAS = ["admin", "developer", "architect"]
PRODUCTS = ["", "agentforce", "platform", "flow", "security", "apex", "lwc", "integration", "mobile", "data-cloud"]
BUDGET_CHARS = 320_000  # ~80k tokens of release-note text per prompt
MIN_SNIPPET = 300
# Broad keyword sets need a section match, a heading keyword, or two distinct body keywords;
# narrow ones (apex, lwc, mobile, data-cloud) count a single mention
MIN_SCORE = {"agentforce": 2, "platform": 2, "flow": 2, "security": 2, "integration": 2}

DIGEST_PROMPT = """Stdin contains a contiguous slice of the Salesforce {release} release notes, each section as "### heading path"
followed by its text. Condense it into dense markdown bullet notes grouped under "### <product area>" headings, keeping every
notable item: feature name, what it does in one line, status (GA/Beta/Pilot/Developer Preview), API versions, limits, dates,
editions, and especially breaking changes, release updates and their enforcement dates, retirements and deprecations.
Skip pure navigation/index text. Use only facts in the input. Aim for 6,000-10,000 characters. Output only the notes."""

# (TOC section titles at any level that put a page in the product, keyword regex)
PRODUCT_RULES = {
    "agentforce": ({"Agentforce and Generative AI", "AIforce", "Setup with Agentforce", "AI Skills", "Agentforce Vibes", "Agentforce Vibes IDE"},
                   r"agentforce|\bagents?\b|einstein|prompt builder|prompt templates?|generative ai|\bllms?\b|subagents?|\bmcp\b|copilot"),
    "apex": ({"Apex"}, r"\bapex\b"),
    "lwc": ({"Lightning Components", "Lightning Design System", "Salesforce Multi-Framework"},
            r"lightning web components?|\blwcs?\b|lightning components?|\bslds\b|aura components?|lightning design system"),
    "flow": ({"Automation", "Flow Builder", "Flow Approval Processes", "Flow Orchestration"},
             r"\bflows?\b|flow builder|orchestrations?|approval process|\bautomation\b|\bautomate"),
    "data-cloud": ({"Data 360", "Data 360 Reports and Dashboards"},
                   r"data 360|data cloud|data model objects?|\bdmos?\b|calculated insights?|identity resolution|data streams?|data graphs?|zero copy|data lake"),
    "integration": ({"API", "API Catalog", "External Services", "Salesforce Connect", "Enterprise Messaging", "Named Credentials", "MuleSoft",
                     "MuleSoft for Flow: Integration", "MuleSoft Integration Intelligence"},
                    r"\bapis?\b|rest api|soap|graphql|platform events?|change data capture|mulesoft|external services?|named credentials?|callouts?|pub/sub|webhooks?|\bodata\b|\bintegrations?\b"),
    "security": ({"Security, Identity, and Privacy", "Permissions and Sharing", "Identity and Access Management", "Salesforce Shield"},
                 r"\bsecurity\b|permission sets?|\bpermissions?\b|sharing rules?|encrypt|shield|authenticat|oauth|\bmfa\b|single sign-on|\bsso\b|\bsessions?\b|passwords?|privacy|connected apps?|external client apps?|field-level security"),
    "platform": ({"Platform", "Customization", "Development", "Deployment", "Salesforce Overall", "Release Updates", "Hyperforce", "General Setup",
                  "DevOps", "Packaging", "Sandbox and Scratch Orgs", "Lightning App Builder", "Globalization", "Platform Development Tools", "Salesforce CLI"},
                 r"sandbox|scratch orgs?|packag|metadata api|devops|lightning app builder|dynamic forms|release updates?|custom objects?|custom fields?|picklists?|\bsetup\b|hyperforce|salesforce cli"),
    "mobile": ({"Mobile", "Field Service Mobile"},
               r"\bmobile\b|\bios\b|android|offline|salesforce mobile app|tablets?|mobile publisher"),
}

PERSONA_FOCUS = {
    "admin": "Salesforce admins: declarative configuration, Setup changes, permissions, user experience, release updates to test/enable, retirements, and what to communicate to users.",
    "developer": "Salesforce developers: code-level changes (Apex, LWC, APIs, CLI/tooling, metadata), new language/platform features, API version changes, breaking changes, deprecations, and migration work.",
    "architect": "Salesforce architects: platform-level and cross-cloud design implications, data/integration/security architecture, scalability and limits, governance, roadmap direction, and strategic trade-offs.",
}


def parse_toc(path):
    """topic -> list of ancestor section titles (outermost first, including the page itself)."""
    toc = open(path, encoding="utf-8").read()
    items = re.findall(r'id="([^"]+)_leaf" role="treeitem" aria-level="(\d+)".*?href="[^"]*?id=release-notes\.([\w.-]+?)\.htm[^"]*">([^<]*)<', toc, re.S)
    stack, sections = [], {}
    for _, level, topic, title in items:
        level = int(level)
        del stack[level - 1:]
        stack.append(re.sub(r"\s+", " ", html.unescape(title)).strip())
        sections.setdefault(topic, list(stack[1:]))  # drop the release-notes root
    return sections


def score(product, chunk, sections):
    names, pattern = PRODUCT_RULES[product]
    rx = re.compile(pattern, re.I)
    s = 5 if any(t in names for t in sections) else 0
    s += 3 * len({m.lower() for m in rx.findall(chunk["heading_path"])})
    s += len({m.lower() for m in rx.findall(chunk["content"])})
    return s


def pack(chunks):
    """Fit chunks into BUDGET_CHARS, truncating each to a common max length first."""
    overhead = lambda c: len(c["heading_path"]) + 8
    lo, hi = MIN_SNIPPET, 1500
    while lo < hi:  # largest per-chunk length that fits everything
        mid = (lo + hi + 1) // 2
        if sum(overhead(c) + min(len(c["content"]), mid) for c in chunks) <= BUDGET_CHARS:
            lo = mid
        else:
            hi = mid - 1
    limit, picked, total = lo, [], 0
    for c in chunks:  # chunks arrive ranked; drop the tail if even MIN_SNIPPET doesn't fit
        cost = overhead(c) + min(len(c["content"]), limit)
        if total + cost > BUDGET_CHARS:
            break
        picked.append(c)
        total += cost
    return picked, limit


def snippet(text, limit):
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > limit // 2 else limit].rstrip() + " …"


def build_prompt(release_label, persona, product, example):
    scope = f"the {product} product area" if product else "the full release across all products"
    return f"""You are writing the pre-generated "{persona}" executive summary of the Salesforce {release_label} release for {scope}.
It is served by an MCP tool (summarize_release) to people asking "what's new in {release_label}".

Audience focus: {PERSONA_FOCUS[persona]}

Stdin contains (1) a REFERENCE summary from the previous release for the same persona and product area, and
(2) the {release_label} release-note sections, each as "### heading path" followed by its text (long sections are truncated with "…"),
or, for the cross-product summary, condensed digest notes covering every release-note section.

Requirements:
- Match the reference's structure, tone and length closely (roughly 3,500-4,500 characters): a single "# " title line naming
  Salesforce {release_label}, 4-6 "## " themed sections with bold key items and concrete specifics (API versions, limits,
  dates, setting names, GA/Beta/Pilot status), then a "---" rule and a final "## Action Items" section with exactly 5 numbered
  or bulleted, concrete actions.
- Use ONLY facts stated in the {release_label} release notes provided. Do not carry over any content from the reference summary,
  and do not invent features, dates or limits. Prioritize breaking changes, enforced release updates, retirements, and the most
  impactful new features for this persona.
- Output only the markdown summary, with no preamble or closing remarks."""


def run_claude(prompt, stdin_text, model, header=True):
    cmd = ["claude", "-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text"]
    if model:
        cmd += ["--model", model]
    cmd.append(prompt)
    for attempt in range(3):
        res = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True, timeout=1800, cwd="/tmp")
        out = res.stdout.strip()
        if res.returncode == 0 and (out.startswith("#") or not header) and len(out) > 1500:
            return out
        print(f"    attempt {attempt + 1} failed (rc={res.returncode}): {(res.stderr or out)[:300]}", file=sys.stderr)
    raise RuntimeError("claude CLI failed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", required=True)
    ap.add_argument("--chunks", required=True)
    ap.add_argument("--toc", required=True)
    ap.add_argument("--examples", required=True)
    ap.add_argument("--example-release", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work-dir", default="/tmp/sfada/summaries-work")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--model", default=None)
    ap.add_argument("--dry-run", action="store_true", help="Only report chunk selection per product")
    args = ap.parse_args()

    season, yy = args.release.split("-")
    release_label = f"{season.capitalize()} '{yy}"
    os.makedirs(args.work_dir, exist_ok=True)

    sections = parse_toc(args.toc)
    order = {t: i for i, t in enumerate(sections)}
    chunks = []
    with open(args.chunks, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            topic = re.search(r"id=release-notes\.([\w.-]+?)\.htm", r["url"]).group(1)
            chunks.append({"heading_path": r["heading_path"], "content": r["content"], "topic": topic, "sections": sections.get(topic, [])})
    print(f"{len(chunks)} chunks", file=sys.stderr)

    examples = {}
    with gzip.open(args.examples, "rt", newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["release"] == args.example_release:
                examples[(r["persona"], r["product"])] = r["summary"]

    prefix = f"{release_label} Release Notes > "
    show = lambda c: c["heading_path"][len(prefix):] if c["heading_path"].startswith(prefix) else c["heading_path"]
    render = lambda cs, limit: "\n\n".join(f"### {show(c)}\n{snippet(c['content'], limit)}" for c in cs)

    # Per product: ranked chunk selection, shared by all personas
    selections = {}
    for product in PRODUCTS[1:]:
        scored = [(score(product, c, c["sections"]), i, c) for i, c in enumerate(chunks)]
        ranked = [c for s, _, c in sorted((x for x in scored if x[0] >= MIN_SCORE.get(product, 1)), key=lambda x: (-x[0], x[1]))]
        picked, limit = pack(ranked)
        picked.sort(key=lambda c: order.get(c["topic"], 1 << 30))  # present in release-notes order
        selections[product] = (picked, render(picked, limit))
        print(f"  {product}: {len(ranked)} relevant, {len(picked)} fed (max {limit} chars each)", file=sys.stderr)

    # General: too large for one prompt, so map-reduce. Every chunk (full text, release-notes order)
    # goes through a persona-neutral digest pass; the general summaries are written from the digests.
    ordered = sorted(chunks, key=lambda c: order.get(c["topic"], 1 << 30))
    batches, cur, size = [], [], 0
    for c in ordered:
        cost = len(show(c)) + len(c["content"]) + 8
        if cur and size + cost > BUDGET_CHARS:
            batches.append(cur)
            cur, size = [], 0
        cur.append(c)
        size += cost
    if cur:
        batches.append(cur)
    print(f"  general: all {len(chunks)} chunks via {len(batches)} digest batches", file=sys.stderr)

    if args.dry_run:
        return

    def digest(i):
        path = os.path.join(args.work_dir, f"digest_{i:02d}.md")
        if not os.path.exists(path):
            batch = batches[i]
            print(f"  digest {i + 1}/{len(batches)} ({len(batch)} chunks)", file=sys.stderr)
            out = run_claude(DIGEST_PROMPT.format(release=release_label), render(batch, 1500), args.model, header=False)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(out)
        return open(path, encoding="utf-8").read().strip()

    with ThreadPoolExecutor(args.jobs) as pool:
        digests = list(pool.map(digest, range(len(batches))))
    selections[""] = (chunks, "\n\n".join(f"## Digest part {i + 1} of {len(digests)}\n{d}" for i, d in enumerate(digests)))

    def job(persona, product):
        key = f"{persona}_{product or 'general'}"
        path = os.path.join(args.work_dir, f"{key}.md")
        if os.path.exists(path):
            return
        picked, body = selections[product]
        ref = examples.get((persona, product), "")
        kind = "RELEASE NOTES" if product else "RELEASE NOTES DIGEST (condensed notes covering every release-note section)"
        stdin_text = f"=== REFERENCE SUMMARY ({args.example_release}, {persona}, {product or 'general'}) ===\n{ref}\n\n=== {release_label} {kind} ===\n\n{body}\n"
        print(f"  generating {key} ({len(picked)} chunks, {len(stdin_text)} chars)", file=sys.stderr)
        out = run_claude(build_prompt(release_label, persona, product, ref), stdin_text, args.model)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(out)
        print(f"  done {key}: {len(out)} chars", file=sys.stderr)

    tasks = [(pe, pr) for pr in PRODUCTS for pe in PERSONAS]
    with ThreadPoolExecutor(args.jobs) as pool:
        for f in [pool.submit(job, pe, pr) for pe, pr in tasks]:
            f.result()

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["release", "persona", "summary", "chunk_count", "model", "product"])
        for persona, product in tasks:
            summary = open(os.path.join(args.work_dir, f"{persona}_{product or 'general'}.md"), encoding="utf-8").read().strip()
            w.writerow([args.release, persona, summary, len(selections[product][0]), "claude-cli", product])
    print(f"Wrote {len(tasks)} summaries to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
