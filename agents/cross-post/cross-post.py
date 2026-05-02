"""
cross-post.py — thin shim so cowork-proxy /run-helper can reach the dryrun.py
helper that lives next to it. The proxy hard-codes the path
agents/<name>/<name>.py — but this folder predates the trigger panel and the
real helper is dryrun.py. Rather than rename and break existing .bat files,
this shim just re-runs dryrun.py with the same argv.
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "dryrun.py")

# Replace argv[0] with the real script so help text reads naturally.
sys.argv[0] = TARGET
runpy.run_path(TARGET, run_name="__main__")
