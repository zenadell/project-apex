```python
#!/usr/bin/env python3
"""
CLI bridge for the websockets package.
Reads JSON commands from stdin and communicates with a WebSocket server,
outputting JSON results to stdout.
"""

import asyncio
import json
import sys
import websockets

async def main():
    url = None
    # Check if URL is provided as command-line argument
    if len(sys.argv) > 1:
        url = sys.argv[1]
    elif not sys.stdin.isatty():
        # Read first line of stdin for initial configuration
        try:
            line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
            if line:
                try:
                    config = json.loads(line.strip())
                    url = config.get("url")
                except json.JSONDecodeError:
                    pass
        except Exception:
            pass

    if not url:
        print(json.dumps({"error": "No WebSocket URL provided. Usage: script <url> or pipe JSON {'url':'...'} on stdin."}))
        sys.exit(1)

    try:
        async with websockets.connect(url) as websocket:
            # Notify connected
            print(json.dumps({"status": "connected", "url": url}))
            sys.stdout.flush()

            # Create tasks for reading from WebSocket and stdin
            async def read_websocket():
                async for message in websocket:
                    # Attempt to parse as JSON; if not, wrap as text
                    try:
                        data = json.loads(message)
                        output = {"type": "message", "data": data}
                    except json.JSONDecodeError:
                        output = {"type": "message", "data": message}
                    print(json.dumps(output))
                    sys.stdout.flush()

            async def read_stdin():
                loop = asyncio.get_event_loop()
                while True:
                    line = await loop.run_in_executor(None, sys.stdin.readline)
                    if not line:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        command = json.loads(line)
                    except json.JSONDecodeError:
                        print(json.dumps({"error": "Invalid JSON input", "input": line}))
                        sys.stdout.flush()
                        continue

                    action = command.get("action")
                    if action == "send":
                        payload = command.get("payload", "")
                        await websocket.send(json.dumps(payload) if isinstance(payload, dict|list) else str(payload))
                        print(json.dumps({"status": "sent"}))
                        sys.stdout.flush()
                    elif action == "close":
                        print(json.dumps({"status": "closing"}))
                        sys.stdout.flush()
                        await websocket.close()
                        break
                    elif action == "ping":
                        await websocket.ping()
                        print(json.dumps({"status": "pong"}))
                        sys.stdout.flush()
                    else:
                        print(json.dumps({"error": f"Unknown action: {action}"}))
                        sys.stdout.flush()

            # Run both tasks concurrently; if one fails or stdin closes, exit
            tasks = [asyncio.create_task(read_websocket()), asyncio.create_task(read_stdin())]
            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
            except asyncio.CancelledError:
                pass

    except websockets.exceptions.InvalidURI as e:
        print(json.dumps({"error": f"Invalid WebSocket URI: {e}"}))
    except websockets.exceptions.WebSocketException as e:
        print(json.dumps({"error": f"WebSocket error: {e}"}))
    except Exception as e:
        print(json.dumps({"error": f"Unexpected error: {e}"}))
    finally:
        print(json.dumps({"status": "disconnected"}))
        sys.stdout.flush()

if __name__ == "__main__":
    asyncio.run(main())
```