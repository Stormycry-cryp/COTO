#!/usr/bin/env python3
"""Minimal COTO HTTP/SSE client using only the Python standard library.

The repository smoke test runs this client against a local COTO HTTP/SSE
server with echoProvider. Production model endpoints need separate validation.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("COTO_URL", "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("COTO_TOKEN")


def headers(**extra: str) -> dict[str, str]:
    result = dict(extra)
    if TOKEN:
        result["Authorization"] = f"Bearer {TOKEN}"
    return result


def post_json(path: str, payload: dict[str, Any], **extra_headers: str) -> dict[str, Any]:
    request = Request(
        BASE_URL + path,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers(**{"Content-Type": "application/json", **extra_headers}),
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def sse_events(session_id: str, after: int) -> Iterator[dict[str, Any]]:
    query = urlencode({"after": after})
    request = Request(
        f"{BASE_URL}/v1/sessions/{session_id}/events?{query}",
        headers=headers(Accept="text/event-stream"),
    )
    event_type = "message"
    data_lines: list[str] = []

    with urlopen(request, timeout=130) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").rstrip("\r\n")
            if not line:
                if data_lines:
                    payload = json.loads("\n".join(data_lines))
                    if event_type == "stream.error":
                        raise RuntimeError(f"SSE stream.error: {payload}")
                    yield payload
                event_type = "message"
                data_lines = []
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if field == "event":
                event_type = value
            elif field == "data":
                data_lines.append(value)


def main() -> int:
    created = post_json("/v1/sessions", {})
    session_id = str(created["meta"]["id"])
    input_id = uuid.uuid4().hex
    prompt = os.environ.get("COTO_PROMPT", "检查项目入口并简要说明如何启动")

    receipt = post_json(
        f"/v1/sessions/{session_id}/inputs",
        {
            "inputId": input_id,
            "mode": "follow_up",
            "content": [{"type": "text", "text": prompt}],
        },
        **{"Idempotency-Key": input_id},
    )
    print(f"session={session_id} acceptedSeq={receipt['acceptedSeq']}", file=sys.stderr)

    cursor = 0
    reconnects = 0
    while reconnects <= 5:
        try:
            for event in sse_events(session_id, cursor):
                seq = int(event["seq"])
                if seq <= cursor:
                    continue
                cursor = seq
                event_type = event["type"]
                if event_type == "text.delta":
                    print(str(event["data"]["text"]), end="", flush=True)
                if event_type in {"turn.completed", "turn.failed", "turn.interrupted"}:
                    print()
                    return 0 if event_type == "turn.completed" else 1
            raise RuntimeError("SSE connection closed before a terminal turn event")
        except (OSError, TimeoutError, URLError, RuntimeError) as error:
            reconnects += 1
            if reconnects > 5:
                print(f"stream failed after retries: {error}", file=sys.stderr)
                return 1
            time.sleep(1)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
