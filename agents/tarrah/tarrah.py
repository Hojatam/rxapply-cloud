#!/usr/bin/env python
"""tarrah · carousel slide planner stub.

The real planning runs through the Compose orchestrator's `carousel-plan`
stage (LLM call). This file exists so the agent registry has a helper
script entry like every other agent — invoked rarely; useful for ad-hoc
local testing.
"""
import sys


def help():
    print("tarrah · carousel slide planner")
    print("Usage: this agent runs as the carousel-plan stage in the")
    print("Compose orchestrator. Invoke via the dashboard's Compose tab")
    print("on an Instagram recipe; Tarrah outputs the slide spec that")
    print("Afshin then renders.")
    print()
    print("For SKILL details: agents/tarrah/SKILL.md")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "help":
        help()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)
