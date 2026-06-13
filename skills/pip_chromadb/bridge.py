```python
#!/usr/bin/env python3
"""
CLI Bridge for ChromaDB – Vector Database for Earnings Call Transcripts.

Usage:
  python chromadb_bridge.py [--input input.json]          # Read from file
  echo '{"action": "query", "collection": "calls", "query_texts": ["revenue growth"], "n_results": 3}' | python chromadb_bridge.py
"""

import json
import sys
import argparse
from typing import Any, Dict, List, Optional

import chromadb
from chromadb.config import Settings
from chromadb.errors import ChromaError


def parse_input() -> Dict[str, Any]:
    """Parse JSON input from file (--input) or stdin."""
    parser = argparse.ArgumentParser(description="ChromaDB CLI Bridge")
    parser.add_argument("--input", "-i", type=str, help="Path to JSON input file")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "r") as f:
            data = json.load(f)
    else:
        # Read from stdin until EOF
        raw = sys.stdin.read()
        if not raw.strip():
            die("No input provided. Use --input or pipe JSON to stdin.", exit_code=1)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            die(f"Invalid JSON input: {e}", exit_code=1)
    return data


def die(message: str, exit_code: int = 1) -> None:
    """Output error as JSON and exit."""
    output = {"status": "error", "message": str(message)}
    print(json.dumps(output, indent=2))
    sys.exit(exit_code)


def success(result: Any) -> None:
    """Output success as JSON."""
    output = {"status": "success", "data": result}
    print(json.dumps(output, indent=2, default=str))


def create_client(persist_directory: str = "./chromadb_data") -> chromadb.ClientAPI:
    """Create a ChromaDB client (persistent by default)."""
    try:
        client = chromadb.PersistentClient(
            path=persist_directory,
            settings=Settings(anonymized_telemetry=False)
        )
        return client
    except Exception as e:
        die(f"Failed to create ChromaDB client: {e}")


def handle_action(client: chromadb.ClientAPI, action: str, params: Dict[str, Any]) -> Any:
    """Route action to the appropriate ChromaDB operation."""
    collection_name = params.get("collection", "default")

    # Actions that may need collection creation/existence
    if action in ("add", "upsert", "update", "get", "query", "delete", "peek"):
        try:
            collection = client.get_collection(name=collection_name)
        except ValueError:
            if action in ("add", "upsert"):
                collection = client.create_collection(name=collection_name)
            else:
                die(f"Collection '{collection_name}' not found.")

    if action == "list_collections":
        collections = client.list_collections()
        return [{"name": c.name, "metadata": c.metadata} for c in collections]

    elif action == "create_collection":
        name = params.get("name", collection_name)
        metadata = params.get("metadata", None)
        client.create_collection(name=name, metadata=metadata)
        return {"created": name}

    elif action == "delete_collection":
        name = params.get("name", collection_name)
        client.delete_collection(name=name)
        return {"deleted": name}

    elif action == "add":
        ids = params["ids"]
        embeddings = params.get("embeddings", None)
        metadatas = params.get("metadatas", None)
        documents = params.get("documents", None)
        collection.add(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents
        )
        return {"added": len(ids)}

    elif action == "upsert":
        ids = params["ids"]
        embeddings = params.get("embeddings", None)
        metadatas = params.get("metadatas", None)
        documents = params.get("documents", None)
        collection.upsert(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents
        )
        return {"upserted": len(ids)}

    elif action == "update":
        ids = params["ids"]
        embeddings = params.get("embeddings", None)
        metadatas = params.get("metadatas", None)
        documents = params.get("documents", None)
        collection.update(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents
        )
        return {"updated": len(ids)}

    elif action == "get":
        ids = params.get("ids", None)
        where = params.get("where", None)
        limit = params.get("limit", None)
        offset = params.get("offset", None)
        include = params.get("include", ["embeddings", "metadatas", "documents"])
        result = collection.get(
            ids=ids,
            where=where,
            limit=limit,
            offset=offset,
            include=include
        )
        # Convert to JSON-serializable dict
        return {
            "ids": result["ids"],
            "embeddings": result["embeddings"],
            "metadatas": result["metadatas"],
            "documents": result["documents"]
        }

    elif action == "query":
        query_texts = params.get("query_texts", None)
        query_embeddings = params.get("query_embeddings", None)
        n_results = params.get("n_results", 10)
        where = params.get("where", None)
        include = params.get("include", ["embeddings", "metadatas", "documents", "distances"])
        result = collection.query(
            query_texts=query_texts,
            query_embeddings=query_embeddings,
            n_results=n_results,
            where=where,
            include=include
        )
        # Convert NumPy arrays to lists
        return {
            "ids": result["ids"],
            "distances": [d.tolist() if d is not None else None for d in result["distances"]],
            "embeddings": [e.tolist() if e is not None else None for e in result["embeddings"]],
            "metadatas": result["metadatas"],
            "documents": result["documents"]
        }

    elif action == "peek":
        limit = params.get("limit", 5)
        result = collection.peek(limit=limit)
        return {
            "ids": result["ids"],
            "embeddings": result["embeddings"],
            "metadatas": result["metadatas"],
            "documents": result["documents"]
        }

    elif action == "count":
        return {"count": collection.count()}

    elif action == "modify":
        name = params.get("name", None)
        metadata = params.get("metadata", None)
        collection.modify(name=name, metadata=metadata)
        return {"modified": collection.name}

    elif action == "delete_entries":
        ids = params.get("ids", None)
        where = params.get("where", None)
        collection.delete(ids=ids, where=where)
        return {"deleted": True}

    else:
        die(f"Unknown action: {action}")


def main():
    data = parse_input()
    action = data.get("action")
    if not action:
        die("Missing 'action' field in input.")

    params = data.get("params", {})
    # Optional persistence directory (default can be overridden in params)
    persist_dir = params.pop("persist_directory", "./chromadb_data")

    client = create_client(persist_directory=persist_dir)

    try:
        result = handle_action(client, action, params)
        success(result)
    except ChromaError as e:
        die(f"ChromaDB error: {e}")
    except Exception as e:
        die(f"Unexpected error: {e}")


if