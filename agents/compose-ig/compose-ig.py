"""
compose-ig — Generate an Instagram post in 3 languages + a shared design plan
              from a single topic. Single Anthropic Sonnet call.

Usage
-----
  python compose-ig.py compose-trio --topic "..." [--tone hype-free]
      Calls Anthropic once. Prints JSON to stdout matching this schema:
        {
          "topic": str, "tone": str,
          "languages": {
            "en": { "caption", "hashtags"[], "first_line_hook", "alt_text" },
            "fa": { ... },  // Persian, RTL Unicode
            "ar": { ... },  // Arabic, RTL Unicode
          },
          "design_plan": {
            "concept", "image_prompt", "palette"[3],
            "layout", "typography", "aspect_ratio", "kind"
          },
          "shared_meta": { "model", "input_tokens", "output_tokens", "cost_usd" }
        }

  python compose-ig.py help
      Print this docstring.

Env
---
  ANTHROPIC_API_KEY   required
  ANTHROPIC_MODEL     optional (default: claude-sonnet-4-5-20250929)
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Force UTF-8 stdout/stderr — required for the Persian/Arabic captions to print
# without crashing on Windows cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL_DEFAULT = "claude-sonnet-4-5-20250929"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

# Per-token pricing for the models we know about. The proxy resolver picks
# the model and passes it via --model; we look up rates here. Falls back to
# Sonnet 4.5 rates if an unknown model is passed.
MODEL_PRICING = {
    "claude-opus-4-7":              (0.000015, 0.000075),  # $15/M in, $75/M out
    "claude-opus-4-6":              (0.000015, 0.000075),
    "claude-sonnet-4-6":            (0.000003, 0.000015),
    "claude-sonnet-4-5-20250929":   (0.000003, 0.000015),  # $3/M in, $15/M out
    "claude-haiku-4-5-20251001":    (0.000001, 0.000005),  # $1/M in, $5/M out
}

SYSTEM_PROMPT = """You are a multilingual social-media composer for the RxApply brand.

RxApply helps internationally-trained dentists migrate and re-license abroad.
The brand voice is:
  - hype-free, calm, specific (real numbers, named exams, named regulators)
  - never gives regulated immigration or clinical advice
  - always includes a soft CTA (e.g. "DM us for the full checklist")
  - inclusive across origin countries; never mocks any system or country
  - cites only verifiable sources (NDEB, ADC, GDC, DHA, etc.) by name

Given a topic + tone, produce ONE Instagram post in three languages
(en / fa / ar) plus ONE shared design plan.

LANGUAGE RULES
  en: native English. Hashtags primarily English (#NDEB, #DentalMigration,
      #InternationalDentist) plus 4-8 topic-specific tags.
  fa: native Persian (Farsi), RTL Unicode characters. Hashtags mix:
      4-6 Persian tags (e.g. #مهاجرت_دندانپزشکی, #دندانپزشکی_بین‌المللی)
      + 2-3 universal English (#NDEB, #DentalMigration).
  ar: native Arabic (Modern Standard Arabic), RTL Unicode. Hashtags mix:
      4-6 Arabic tags (e.g. #طب_الأسنان, #هجرة_الأطباء)
      + 2-3 universal English.

CAPTION RULES
  - Each caption ≤ 2200 characters TOTAL (Instagram hard limit)
  - First line is the hook (≤ 100 chars) — what readers see in feed before "more"
  - Body ~80–250 words
  - Hashtags appear at the END, separated from body by 1 blank line, between
    8 and 30 hashtags inclusive
  - No emoji-stuffing; max 4 emojis per caption
  - Never include a fake URL or fake price; only real, named institutions

DESIGN PLAN
  - ONE shared concept used for all 3 language variants (only the caption text differs)
  - palette: indigo primary "#4f46e5" + slate "#0f172a" + neutral "#f8fafc"
  - typography: "Inter EN / Vazirmatn FA-AR"
  - aspect_ratio: "1:1"  (Instagram square; 1080x1080)
  - kind: "ig_carousel_slide"
  - image_prompt: detailed enough that gpt-image-1 / DALL-E 3 / Stability /
    Ideogram can produce a brand-consistent image. Specify NO embedded text in
    the image (text overlays are added later or by IG itself).

OUTPUT
Return ONLY a JSON object matching this exact schema. No prose. No markdown
fences. Plain JSON. The reader is a parser; one syntax slip and the run fails.

{
  "topic": "<echoed topic>",
  "tone": "<echoed tone>",
  "languages": {
    "en": { "caption": "...", "hashtags": ["#a", ...],
            "first_line_hook": "...", "alt_text": "..." },
    "fa": { "caption": "...", "hashtags": ["#a", ...],
            "first_line_hook": "...", "alt_text": "..." },
    "ar": { "caption": "...", "hashtags": ["#a", ...],
            "first_line_hook": "...", "alt_text": "..." }
  },
  "design_plan": {
    "concept": "<one-paragraph human-readable concept>",
    "image_prompt": "<detailed image-gen prompt, no embedded text>",
    "palette": ["#4f46e5", "#0f172a", "#f8fafc"],
    "layout": "<short layout description>",
    "typography": "Inter EN / Vazirmatn FA-AR",
    "aspect_ratio": "1:1",
    "kind": "ig_carousel_slide"
  }
}
"""


def call_anthropic(topic: str, tone: str, model: str,
                    brand_block: str = "", memory_block: str = "",
                    knowledge_block: str = "",
                    max_tokens: int = 4000) -> dict:
    if not ANTHROPIC_KEY:
        sys.stderr.write("error: ANTHROPIC_API_KEY not set in env\n")
        sys.exit(2)

    # Build the system prompt: agent rules + (optionally) the central brand
    # profile + (optionally) the knowledge base + (optionally) the agent's
    # memory — all injected by the proxy.
    parts = [SYSTEM_PROMPT]
    if brand_block:
        parts.append(brand_block)
    if knowledge_block:
        parts.append(knowledge_block)
    if memory_block:
        parts.append(memory_block)
    system = "\n\n".join(parts)

    user_msg = f"Topic: {topic}\nTone: {tone}\n\nReturn the JSON now."
    body = json.dumps(
        {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user_msg}],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        method="POST",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")[:600]
        sys.stderr.write(f"Anthropic {e.code}: {err}\n")
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"Anthropic call failed: {e}\n")
        sys.exit(1)


def extract_json(text: str) -> dict:
    """Pull a JSON object out of the response. Strip markdown fences if present."""
    s = text.strip()
    if s.startswith("```"):
        # Drop opening fence (and optional 'json' tag), drop closing fence
        lines = s.split("\n")
        if lines and lines[0].lstrip("`").strip().lower() in ("", "json"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    # Fallback: trim to outermost braces
    if not s.startswith("{"):
        i = s.find("{")
        if i >= 0:
            s = s[i:]
    if not s.endswith("}"):
        j = s.rfind("}")
        if j > 0:
            s = s[: j + 1]
    return json.loads(s)


def validate_shape(result: dict) -> list:
    """Return list of warnings; empty means OK."""
    warnings = []
    langs = result.get("languages") or {}
    for lang in ("en", "fa", "ar"):
        l = langs.get(lang)
        if not isinstance(l, dict):
            warnings.append(f"missing languages.{lang}")
            continue
        cap = l.get("caption") or ""
        if not cap:
            warnings.append(f"languages.{lang}.caption is empty")
        elif len(cap) > 2200:
            warnings.append(f"languages.{lang}.caption is {len(cap)} chars (>2200 limit)")
        tags = l.get("hashtags") or []
        if len(tags) < 8:
            warnings.append(f"languages.{lang} has only {len(tags)} hashtags (<8 minimum)")
        elif len(tags) > 30:
            warnings.append(f"languages.{lang} has {len(tags)} hashtags (>30 limit)")
    dp = result.get("design_plan") or {}
    for f in ("concept", "image_prompt"):
        if not dp.get(f):
            warnings.append(f"design_plan.{f} is empty")
    return warnings


def cmd_compose_trio(topic: str, tone: str, model: str, brand_block: str = "",
                      memory_block: str = "", knowledge_block: str = ""):
    api_resp = call_anthropic(topic, tone, model, brand_block, memory_block, knowledge_block)
    blocks = api_resp.get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    try:
        result = extract_json(text)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"failed to parse model output as JSON: {e}\n")
        sys.stderr.write("first 800 chars of output:\n")
        sys.stderr.write(text[:800] + "\n")
        sys.exit(1)

    # Echo inputs (model usually echoes too, but we want canonical values)
    result["topic"] = topic
    result["tone"] = tone

    # Look up actual rates for the model used (Opus is 5× Sonnet, etc.).
    in_rate, out_rate = MODEL_PRICING.get(model, MODEL_PRICING[ANTHROPIC_MODEL_DEFAULT])
    usage = api_resp.get("usage", {})
    in_t = usage.get("input_tokens", 0)
    out_t = usage.get("output_tokens", 0)
    cost = in_t * in_rate + out_t * out_rate
    result["shared_meta"] = {
        "model": api_resp.get("model", model),
        "input_tokens": in_t,
        "output_tokens": out_t,
        "cost_usd": round(cost, 6),
    }

    warnings = validate_shape(result)
    if warnings:
        result["_warnings"] = warnings

    print(json.dumps(result, indent=2, ensure_ascii=False))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd in ("help", "--help", "-h"):
        print(__doc__)
        return
    if cmd != "compose-trio":
        sys.stderr.write(f"unknown command: {cmd}\n")
        sys.stderr.write(__doc__ + "\n")
        sys.exit(2)
    ap = argparse.ArgumentParser(prog="compose-ig.py compose-trio")
    ap.add_argument("--topic", required=True, help="topic to compose about (one or two sentences)")
    ap.add_argument("--tone", default="hype-free", choices=["hype-free", "informative", "encouraging"])
    ap.add_argument("--model", default=os.environ.get("ANTHROPIC_MODEL") or ANTHROPIC_MODEL_DEFAULT,
                    help="Anthropic model id (proxy passes per-agent override)")
    ap.add_argument("--brand-block", default="",
                    help="brand profile rendered as a prompt block (proxy injects)")
    ap.add_argument("--memory-block", default="",
                    help="agent memory rendered as a prompt block (proxy injects)")
    ap.add_argument("--knowledge-block", default="",
                    help="knowledge base rendered as a prompt block (proxy injects, K6)")
    args = ap.parse_args(sys.argv[2:])
    cmd_compose_trio(args.topic, args.tone, args.model, args.brand_block,
                     args.memory_block, args.knowledge_block)


if __name__ == "__main__":
    main()
