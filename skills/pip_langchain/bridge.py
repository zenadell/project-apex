```python
#!/usr/bin/env python3
"""
APEX LangChain CLI Bridge
=========================
Accepts JSON input via stdin or command-line argument,
processes it with LangChain components, and returns JSON output.
Supports actions: retrieve, query, embed, generate.
"""

import json
import sys
import os
import argparse
from typing import Any, Dict

# LangChain imports (optional - handle missing gracefully)
try:
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from langchain_community.vectorstores import Chroma
    from langchain_core.documents import Document
    from langchain_core.prompts import ChatPromptTemplate
    from langchain.text_splitter import RecursiveCharacterTextSplitter
    from langchain.chains import create_retrieval_chain
    from langchain.chains.combine_documents import create_stuff_documents_chain
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False


def error_response(message: str, code: int = 1) -> Dict[str, Any]:
    """Return a JSON error response."""
    return {"status": "error", "error": message, "code": code}


def success_response(data: Any) -> Dict[str, Any]:
    """Return a JSON success response."""
    return {"status": "success", "data": data}


def read_input() -> Dict[str, Any]:
    """Read JSON input from stdin or command-line argument."""
    parser = argparse.ArgumentParser(description="APEX LangChain CLI Bridge")
    parser.add_argument("--input", "-i", type=str, help="JSON input string")
    args = parser.parse_args()

    if args.input:
        try:
            return json.loads(args.input)
        except json.JSONDecodeError as e:
            print(json.dumps(error_response(f"Invalid JSON in --input: {e}")))
            sys.exit(1)
    else:
        try:
            return json.loads(sys.stdin.read())
        except json.JSONDecodeError as e:
            print(json.dumps(error_response(f"Invalid JSON from stdin: {e}")))
            sys.exit(1)


def validate_input(data: Dict[str, Any]) -> None:
    """Ensure required fields exist."""
    if "action" not in data:
        raise ValueError("Missing 'action' field in input")
    allowed = ["retrieve", "query", "embed", "generate"]
    if data["action"] not in allowed:
        raise ValueError(f"Action must be one of {allowed}, got '{data['action']}'")


def get_llm(model: str = "gpt-3.5-turbo") -> ChatOpenAI:
    """Initialize a ChatOpenAI instance."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError("OPENAI_API_KEY environment variable not set")
    return ChatOpenAI(model=model, temperature=0, api_key=api_key)


def get_embeddings() -> OpenAIEmbeddings:
    """Initialize OpenAIEmbeddings."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError("OPENAI_API_KEY environment variable not set")
    return OpenAIEmbeddings(api_key=api_key)


def handle_retrieve(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Retrieve documents from a vector store.
    Input: {"action":"retrieve","query":"...","collection_name":"...","k":3}
    """
    query = data.get("query")
    collection_name = data.get("collection_name", "default")
    k = data.get("k", 4)

    if not query:
        raise ValueError("Missing 'query' field for retrieve action")

    embeddings = get_embeddings()
    # Attempt to load existing Chroma store (directory from env or default)
    persist_dir = data.get("persist_directory", os.environ.get("CHROMA_PERSIST_DIR", "./chroma_db"))
    vectorstore = Chroma(
        collection_name=collection_name,
        embedding_function=embeddings,
        persist_directory=persist_dir
    )
    docs = vectorstore.similarity_search(query, k=k)
    results = [{"content": doc.page_content, "metadata": doc.metadata} for doc in docs]
    return success_response(results)


def handle_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run a RAG query: retrieve and then answer using LLM.
    Input: {"action":"query","query":"...","collection_name":"...","model":"gpt-4"}
    """
    query = data.get("query")
    if not query:
        raise ValueError("Missing 'query' field for query action")

    model = data.get("model", "gpt-3.5-turbo")
    llm = get_llm(model)
    embeddings = get_embeddings()
    persist_dir = data.get("persist_directory", os.environ.get("CHROMA_PERSIST_DIR", "./chroma_db"))
    collection_name = data.get("collection_name", "default")
    vectorstore = Chroma(
        collection_name=collection_name,
        embedding_function=embeddings,
        persist_directory=persist_dir
    )

    # Build RAG chain
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a helpful assistant. Use the following context to answer the question."),
        ("human", "Context: {context}\n\nQuestion: {input}")
    ])
    document_chain = create_stuff_documents_chain(llm, prompt)
    retriever = vectorstore.as_retriever(search_kwargs={"k": data.get("k", 4)})
    retrieval_chain = create_retrieval_chain(retriever, document_chain)
    response = retrieval_chain.invoke({"input": query})
    answer = response.get("answer", "")
    context = [{"content": doc.page_content, "metadata": doc.metadata} for doc in response.get("context", [])]
    return success_response({"answer": answer, "context": context})


def handle_embed(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Embed text(s) and optionally store in vector store.
    Input: {"action":"embed","texts":["...","..."],"collection_name":"...","store":true}
    """
    texts = data.get("texts")
    if not texts:
        raise ValueError("Missing 'texts' field for embed action")
    if isinstance(texts, str):
        texts = [texts]

    embeddings = get_embeddings()
    embedded = embeddings.embed_documents(texts)
    results = [{"text": t, "embedding": emb} for t, emb in zip(texts, embedded)]

    # If store flag is true, also save to Chroma
    if data.get("store", False):
        persist_dir = data.get("persist_directory", os.environ.get("CHROMA_PERSIST_DIR", "./chroma_db"))
        collection_name = data.get("collection_name", "default")
        # Create documents with metadata if provided
        metadatas = data.get("metadatas", [{}] * len(texts))
        docs = [Document(page_content=t, metadata=m) for t, m in zip(texts, metadatas)]
        vectorstore = Chroma.from_documents(
            documents=docs,
            embedding=embeddings,
            collection_name=collection_name,
            persist_directory=persist_dir
        )
        vectorstore.persist()
        results = {"stored": True, "count": len(texts), "data": results}

    return success_response(results)


def handle_generate(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generate text using LLM (no retrieval).
    Input: {"action":"generate","prompt":"...","model":"gpt-4"}
    """
    prompt = data.get("prompt")
   