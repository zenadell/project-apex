```python
import sys
import json
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from fastapi.encoders import jsonable_encoder

app = FastAPI()

# ---------- Endpoints ----------
@app.post("/api/bridge")
async def bridge_http(request: Request):
    """Generic HTTP endpoint that echoes the incoming JSON data."""
    try:
        data = await request.json()
        return {"status": "ok", "data": jsonable_encoder(data)}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.websocket("/ws/bridge")
async def bridge_ws(websocket: WebSocket):
    """Generic WebSocket endpoint that echoes received JSON messages."""
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            parsed = json.loads(data)
            response = {"status": "ok", "data": parsed}
            await websocket.send_text(json.dumps(response))
    except Exception as e:
        await websocket.send_text(json.dumps({"status": "error", "message": str(e)}))

# ---------- CLI Bridge ----------
client = TestClient(app)

def process_input(data: dict) -> dict:
    """Send input data to the HTTP bridge endpoint via TestClient."""
    response = client.post("/api/bridge", json=data)
    return response.json()

def main():
    try:
        # Read JSON input from command-line arguments or stdin
        if len(sys.argv) > 1:
            input_str = " ".join(sys.argv[1:])
        else:
            input_str = sys.stdin.read()

        input_data = json.loads(input_str)
        result = process_input(input_data)
        print(json.dumps(result, indent=2, ensure_ascii=False))

    except json.JSONDecodeError as e:
        error_output = {"error": "Invalid JSON input", "detail": str(e)}
        print(json.dumps(error_output), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        error_output = {"error": "Processing error", "detail": str(e)}
        print(json.dumps(error_output), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
```