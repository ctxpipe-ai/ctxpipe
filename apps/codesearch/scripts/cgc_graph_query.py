"""
CodeGraphContext graph primitive runner for codesearch.

Reads JSON from stdin, writes JSON to stdout. The parent process must set
KUZUDB_PATH and DATABASE_TYPE=kuzudb in the environment before spawning this
script (see executeGraphPrimitive.ts).
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _abs_file_path(repo_path: str, file_path: Optional[str]) -> Optional[str]:
    if not file_path:
        return None
    p = Path(file_path)
    if p.is_absolute():
        return str(p.resolve())
    return str((Path(repo_path) / file_path).resolve())


def _limit_rows(
    rows: List[Dict[str, Any]], limit: Optional[int]
) -> List[Dict[str, Any]]:
    if limit is None or limit <= 0:
        return rows
    return rows[:limit]


def _trace_callee_bfs(
    finder: Any,
    start_name: str,
    start_file_abs: str,
    repo_path: str,
    max_depth: int,
    limit: int,
    end_name: Optional[str],
) -> List[Dict[str, Any]]:
    """Limited-depth callee expansion from an anchored function."""
    results: List[Dict[str, Any]] = []
    if max_depth <= 0:
        return results

    visited: set[Tuple[str, str]] = set()
    queue: deque[Tuple[int, str, str]] = deque()
    queue.append((0, start_name, start_file_abs))

    while queue and len(results) < limit:
        depth, fname, fpath = queue.popleft()
        if depth >= max_depth:
            continue
        key = (fname, fpath)
        if key in visited:
            continue
        visited.add(key)

        callees = finder.what_does_function_call(fname, path=fpath, repo_path=repo_path)
        for c in callees:
            if len(results) >= limit:
                break
            called = c.get("called_function")
            called_path = c.get("called_file_path") or ""
            row = {
                "depth": depth + 1,
                "caller": fname,
                "caller_file_path": fpath,
                "called": called,
                "called_file_path": called_path,
                "call_line_number": c.get("call_line_number"),
                "full_call_name": c.get("full_call_name"),
            }
            results.append(row)
            if end_name and called == end_name:
                return results
            if depth + 1 < max_depth and called_path:
                queue.append((depth + 1, str(called), str(called_path)))
        if end_name and any(r.get("called") == end_name for r in results):
            return results

    return results


def _find_symbols_in_file(
    session: Any, abs_path: str, repo_path: str, limit: int
) -> List[Dict[str, Any]]:
    """Kùzu-friendly listing of contained symbols (avoid Neo4j-only helpers like labels())."""
    kinds = [
        ("Function", "function"),
        ("Class", "class"),
        ("Variable", "variable"),
        ("Trait", "trait"),
        ("Interface", "interface"),
        ("Struct", "struct"),
        ("Enum", "enum"),
    ]
    rows: List[Dict[str, Any]] = []
    for label, kind in kinds:
        q = f"""
            MATCH (f:File)-[:CONTAINS]->(n:{label})
            WHERE f.path = $path
            RETURN
                $kind AS kind,
                n.name AS name,
                n.path AS path,
                n.line_number AS line_number,
                n.docstring AS docstring,
                n.is_dependency AS is_dependency
            ORDER BY n.line_number
            LIMIT $limit
        """
        result = session.run(q, path=abs_path, kind=kind, limit=limit)
        rows.extend(result.data())
    rows.sort(key=lambda r: (r.get("line_number") is None, r.get("line_number") or 0))
    if repo_path:
        rows = [
            r for r in rows if not r.get("path") or str(r["path"]).startswith(repo_path)
        ]
    return rows[:limit]


def _get_containing_scope(
    session: Any, symbol: str, abs_path: str, repo_path: str
) -> List[Dict[str, Any]]:
    kinds = [("Function", "function"), ("Class", "class"), ("Variable", "variable")]
    rows: List[Dict[str, Any]] = []
    for label, kind in kinds:
        q = f"""
            MATCH (n:{label})
            WHERE n.name = $symbol AND n.path = $path
            OPTIONAL MATCH (container)-[:CONTAINS]->(n)
            WHERE container:Function OR container:Class OR container:File
            RETURN DISTINCT
                $kind AS node_kind,
                n.name AS symbol,
                n.path AS path,
                n.line_number AS line_number,
                CASE
                    WHEN container:Function THEN 'function'
                    WHEN container:Class THEN 'class'
                    WHEN container:File THEN 'file'
                    ELSE 'unknown'
                END AS scope_type,
                CASE
                    WHEN container:Function THEN container.name
                    WHEN container:Class THEN container.name
                    WHEN container:File THEN container.name
                    ELSE NULL
                END AS scope_name,
                container.path AS scope_path
            LIMIT 20
        """
        result = session.run(q, symbol=symbol, path=abs_path, kind=kind)
        rows.extend(result.data())
    if repo_path:
        rows = [
            r for r in rows if not r.get("path") or str(r["path"]).startswith(repo_path)
        ]
    return rows


def _file_imports(
    session: Any, abs_path: str, repo_path: str, limit: int
) -> List[Dict[str, Any]]:
    q = """
        MATCH (f:File)-[imp:IMPORTS]->(m:Module)
        WHERE f.path = $path
        RETURN
            m.name AS module_name,
            m.full_import_name AS full_import_name,
            imp.alias AS alias,
            imp.imported_name AS imported_name,
            imp.line_number AS line_number,
            f.path AS file_path
        ORDER BY imp.line_number
        LIMIT $limit
    """
    result = session.run(q, path=abs_path, limit=limit)
    rows = result.data()
    if repo_path:
        rows = [
            r
            for r in rows
            if not r.get("file_path") or str(r["file_path"]).startswith(repo_path)
        ]
    return rows


def run(payload: Dict[str, Any]) -> Dict[str, Any]:
    primitive = payload.get("primitive")
    repo_path = str(payload.get("repoPath") or "")
    if not repo_path:
        return {"ok": False, "error": "repoPath is required"}

    limit = int(payload["limit"]) if payload.get("limit") is not None else 50
    max_depth = int(payload["maxDepth"]) if payload.get("maxDepth") is not None else 5

    os.environ["DATABASE_TYPE"] = "kuzudb"
    if payload.get("kuzuDbPath"):
        os.environ["KUZUDB_PATH"] = str(payload["kuzuDbPath"])

    from codegraphcontext.core import get_database_manager
    from codegraphcontext.tools.code_finder import CodeFinder

    db_manager = get_database_manager()
    finder = CodeFinder(db_manager)

    symbol = payload.get("symbol")
    file_path = payload.get("filePath")
    module = payload.get("module")
    abs_path = _abs_file_path(repo_path, file_path) if file_path else None

    try:
        if primitive == "find_symbol":
            rows: List[Dict[str, Any]] = []
            if module:
                rows.extend(finder.find_by_module_name(str(module)))
            if symbol:
                rows.extend(
                    finder.find_by_function_name(str(symbol), True, repo_path=repo_path)
                )
                rows.extend(
                    finder.find_by_class_name(str(symbol), True, repo_path=repo_path)
                )
            if file_path and abs_path:
                with finder.driver.session() as session:
                    rows.extend(
                        _find_symbols_in_file(session, abs_path, repo_path, limit)
                    )
            seen = set()
            deduped: List[Dict[str, Any]] = []
            for r in rows:
                key = json.dumps(r, sort_keys=True, default=str)
                if key not in seen:
                    seen.add(key)
                    deduped.append(r)
            return {"ok": True, "results": _limit_rows(deduped, limit)}

        if primitive == "get_callers":
            if not symbol:
                return {"ok": False, "error": "get_callers requires symbol"}
            rows = finder.who_calls_function(
                str(symbol), path=abs_path, repo_path=repo_path
            )
            return {"ok": True, "results": _limit_rows(rows, limit)}

        if primitive == "get_callees":
            if not symbol:
                return {"ok": False, "error": "get_callees requires symbol"}
            rows = finder.what_does_function_call(
                str(symbol), path=abs_path, repo_path=repo_path
            )
            return {"ok": True, "results": _limit_rows(rows, limit)}

        if primitive == "get_imports":
            rows = []
            if abs_path:
                with finder.driver.session() as session:
                    rows = _file_imports(session, abs_path, repo_path, limit)
            elif module:
                rows = finder.who_imports_module(str(module), repo_path=repo_path)
            elif symbol:
                rows = finder.who_imports_module(str(symbol), repo_path=repo_path)
            else:
                return {
                    "ok": False,
                    "error": "get_imports requires filePath or module (or symbol as module)",
                }
            return {"ok": True, "results": _limit_rows(rows, limit)}

        if primitive == "get_type_hierarchy":
            if not symbol:
                return {
                    "ok": False,
                    "error": "get_type_hierarchy requires symbol (class name)",
                }
            hierarchy = finder.find_class_hierarchy(
                str(symbol), path=abs_path, repo_path=repo_path
            )
            return {"ok": True, "results": [hierarchy]}

        if primitive == "get_containing_scope":
            if not symbol or not abs_path:
                return {
                    "ok": False,
                    "error": "get_containing_scope requires symbol and filePath",
                }
            with finder.driver.session() as session:
                rows = _get_containing_scope(session, str(symbol), abs_path, repo_path)
            return {"ok": True, "results": _limit_rows(rows, limit)}

        if primitive == "trace_path":
            if not symbol or not abs_path:
                return {"ok": False, "error": "trace_path requires symbol and filePath"}
            end_symbol = payload.get("endSymbol")
            trace_limit = min(limit, 200)
            rows = _trace_callee_bfs(
                finder,
                str(symbol),
                abs_path,
                repo_path,
                max_depth=max_depth,
                limit=trace_limit,
                end_name=str(end_symbol) if end_symbol else None,
            )
            note = None
            if end_symbol and not any(r.get("called") == end_symbol for r in rows):
                note = f"No callee chain reached end symbol {end_symbol!r} within maxDepth={max_depth}"
            return {"ok": True, "results": rows, "note": note}

        return {"ok": False, "error": f"Unknown primitive: {primitive!r}"}
    finally:
        try:
            db_manager.close_driver()
        except Exception:
            pass


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        out = run(payload)
        sys.stdout.write(json.dumps(out, default=str))
        sys.stdout.flush()
        return 0 if out.get("ok") else 2
    except Exception as e:
        err = {
            "ok": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        sys.stdout.write(json.dumps(err, default=str))
        sys.stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
