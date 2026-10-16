#!/usr/bin/env python3
"""Submit and automatically queue one Reachr group post from Claude Code or a shell."""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_URL = "https://n8n.wildeautomations.com/reachr-submit"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", nargs="?", help="Submission JSON file (default: stdin)")
    args = parser.parse_args()
    key = os.environ.get("REACHR_SUBMIT_KEY", "").strip()
    if not key:
        print("REACHR_SUBMIT_KEY is missing", file=sys.stderr)
        return 2
    try:
        if args.json_file:
            with open(args.json_file, encoding="utf-8") as source:
                submission = json.load(source)
        else:
            submission = json.load(sys.stdin)
        body = json.dumps(submission).encode("utf-8")
    except (OSError, ValueError) as error:
        print(f"Invalid submission JSON: {error}", file=sys.stderr)
        return 2

    request = urllib.request.Request(
        os.environ.get("REACHR_SUBMIT_URL", DEFAULT_URL),
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": "ReachrPartnerSubmit/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=75) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error)
            reason = detail.get("error", "Submission failed")
        except (ValueError, OSError):
            reason = "Submission failed"
        print(f"Reachr rejected submission ({error.code}): {reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Could not reach Reachr: {error.reason}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    if result.get('status') != 'queued':
        print('Reachr stored the submission but could not queue it; see queue.error above.', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
