import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    health_url = os.environ.get("RENDER_HEALTH_URL", "").strip()
    if not health_url:
        print("RENDER_HEALTH_URL is required.", file=sys.stderr)
        return 1

    request = urllib.request.Request(
        health_url,
        headers={"User-Agent": "classroom-callboard-huggingface-keepalive/1.0"},
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(500).decode("utf-8", errors="replace")
            print(f"status={response.status} body={body}")
            return 0 if 200 <= response.status < 300 else 1
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"keepalive failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
