"""Manage GitHub Pages for onochin/app_mira with existing Git credentials.

Python standard library only. Credentials remain in memory, are sent only to
api.github.com for authentication, and are never printed or written to disk.
Publication requires the user to authorise it in the current work session.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPOSITORY = "onochin/app_mira"
BASE = f"/repos/{REPOSITORY}"


class GitHub:
    def __init__(self):
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never")
        result = subprocess.run(
            ["git", "-c", "credential.interactive=never", "credential", "fill"],
            input=f"protocol=https\nhost=github.com\npath={REPOSITORY}.git\n\n",
            text=True, capture_output=True, env=env, timeout=45,
        )
        if result.returncode:
            raise RuntimeError("Saved GitHub authentication was unavailable; no credentials were displayed")
        fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        self._token = fields.get("password")
        if not self._token:
            raise RuntimeError("The Git credential helper did not return authentication")

    def request(self, method, endpoint, body=None, missing_ok=False):
        if not endpoint.startswith(BASE):
            raise RuntimeError("Request outside the explicitly selected repository was refused")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            "https://api.github.com" + endpoint, data=data, method=method,
            headers={"Accept": "application/vnd.github+json", "Authorization": "Bearer " + self._token,
                     "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "app-mira-pages",
                     "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                payload = response.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            try:
                message = json.loads(error.read()).get("message", error.reason)
            except (ValueError, UnicodeError):
                message = error.reason
            raise RuntimeError(f"GitHub {method} {endpoint}: HTTP {error.code}: {message}") from None


def summary(client):
    repo = client.request("GET", BASE)
    pages = client.request("GET", BASE + "/pages", missing_ok=True)
    build = client.request("GET", BASE + "/pages/builds/latest", missing_ok=True) if pages else None
    return {
        "repository": {k: repo.get(k) for k in ["full_name", "private", "visibility", "default_branch", "has_pages"]},
        "admin": bool(repo.get("permissions", {}).get("admin")),
        "pages": {k: pages.get(k) for k in ["html_url", "status", "build_type", "source", "https_enforced"]} if pages else None,
        "latest_build": {k: build.get(k) for k in ["status", "commit", "error", "created_at", "updated_at"]} if build else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inspect", "publish", "request-build", "status"])
    args = parser.parse_args()
    client = GitHub()
    if args.action == "publish":
        repo = client.request("GET", BASE)
        if repo.get("full_name", "").lower() != REPOSITORY or not repo.get("permissions", {}).get("admin"):
            raise RuntimeError("Repository administrator access was not confirmed")
        if repo.get("private"):
            repo = client.request("PATCH", BASE, {"private": False})
        if repo.get("private"):
            raise RuntimeError("Repository visibility is still private")
        pages = client.request("GET", BASE + "/pages", missing_ok=True)
        settings = {"build_type": "legacy", "source": {"branch": "main", "path": "/"}}
        if pages is None:
            client.request("POST", BASE + "/pages", settings)
        elif pages.get("build_type") != "legacy" or pages.get("source") != settings["source"]:
            client.request("PUT", BASE + "/pages", settings)
        print(json.dumps(summary(client), ensure_ascii=True))
    elif args.action == "request-build":
        build = client.request("POST", BASE + "/pages/builds")
        print(json.dumps({"build": {k: build.get(k) for k in ["url", "status"]}}, ensure_ascii=True))
    else:
        print(json.dumps(summary(client), ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print request objects, environment, credential-helper output, or tracebacks.
        print(f"Publication operation failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
