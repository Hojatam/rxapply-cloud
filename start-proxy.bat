@echo off
REM ─── DEPRECATED in the cloud build ──────────────────────────────────
REM This file existed in the local sandbox to launch the proxy with
REM hard-coded env vars. The cloud build uses a Procfile / Dockerfile
REM and reads everything from real environment variables (Railway env
REM dashboard, or a local `.env` file in development).
REM
REM For local development of the cloud build:
REM   1. Copy .env.example to .env and fill in the values
REM   2. Run:  cd cowork-proxy && node server.js
REM
REM For Railway:
REM   The Procfile + railway.json define how the app starts.
REM
REM This stub stays only so the file isn't gone from the tree (less
REM confusion vs total removal). DO NOT add secrets back here.
REM ────────────────────────────────────────────────────────────────────
echo This file is deprecated in the cloud build. See the comment in this file.
echo For local dev: copy .env.example to .env, then `cd cowork-proxy ^&^& node server.js`
pause
