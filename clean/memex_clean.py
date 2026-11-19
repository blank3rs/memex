# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "mlx-lm>=0.32.2",
#   "presidio-analyzer>=2.2.366",
#   "presidio-anonymizer>=2.2.366",
#   "pyarrow>=18",
#   "regex>=2024.11.6",
#   "tldextract>=5.3.1",
# ]
# ///
"""Privacy filter for `mymemex export` Parquet, run on the Mac. Flagged text never leaves the machine.

    uv run clean/memex_clean.py --in <export dir> --out <clean dir> --held <held dir>

1. Deterministic: PII in text, meta.context, author, thread_name and thread_id becomes typed placeholders
   ([PHONE], [EMAIL], [ADDRESS], [CARD], [ACCOUNT], [SSN], [SIN], [CODE], [PASSWORD]); handles in author and
   thread_id become stable pseudonyms so threads stay intact. A slur (clean/slurs.txt) holds the row.
2. Model: a local open model labels rows sexual / deep_personal / third_party_private / ok, by thread.
   Labels are appended to <held>/_labels/<model>-<prompt version>/<source>.jsonl as they finish, so a
   stopped run resumes where it left off; an edited row (same id, new text) is labelled again.
3. Output: rows labelled only "ok" go to <out>/<source>/part-00000.parquet (input schema + `labels`);
   every other row goes to <held>/<source>/part-00000.parquet. Summary: stdout and <held>/summary.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")  # read when huggingface_hub is imported (via tagger)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from redact import Redactor
from tagger import HOLD, MODEL, PROMPT_VERSION, Msg, Tagger, Window, windows

log = logging.getLogger("memex-clean")
HERE = Path(__file__).resolve().parent
KEEP = {"ok"}


def _digest(*parts: str) -> str:
    return hashlib.sha1("\x00".join(parts).encode()).hexdigest()[:16]


def _order(r: dict[str, Any]) -> tuple[Any, ...]:
    """Output order: by thread, then time (rows without a time first)."""
    return (r["thread_id"] or "", r["ts"] is not None, r["ts"] or 0)


def load_rows(src: Path) -> tuple[pa.Schema, list[dict[str, Any]]]:
    """All rows of one source; when an id appears in several parts, the newest part's copy wins."""
    files = sorted(src.glob("part-*.parquet"), key=lambda f: (f.stat().st_mtime, f.name))
    tables = [pq.read_table(f) for f in files]
    table = pa.concat_tables(tables, promote_options="default")
    rows: dict[str, dict[str, Any]] = {}
    for r in table.to_pylist():
        rows.pop(r["id"], None)
        rows[r["id"]] = r
    return table.schema, list(rows.values())


class Ledger:
    """Append-only labels per (id, content digest), on the Mac. Survives a stopped run."""

    def __init__(self, path: Path):
        self.path = path
        self.done: dict[str, tuple[str, list[str]]] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a line cut by a hard stop
                self.done[e["id"]] = (e["h"], e["labels"])
        path.parent.mkdir(parents=True, exist_ok=True)
        self._f = path.open("a")

    def get(self, rid: str, h: str) -> list[str] | None:
        hit = self.done.get(rid)
        return hit[1] if hit and hit[0] == h else None

    def add(self, entries: list[tuple[str, str, list[str]]]) -> None:
        for rid, h, labels in entries:
            self._f.write(json.dumps({"id": rid, "h": h, "labels": labels}) + "\n")
            self.done[rid] = (h, labels)
        self._f.flush()
        os.fsync(self._f.fileno())

    def close(self) -> None:
        self._f.close()


def write_part(dirpath: Path, schema: pa.Schema, rows: list[dict[str, Any]]) -> None:
    dirpath.mkdir(parents=True, exist_ok=True)
    tmp = dirpath / ".part-00000.parquet.tmp"
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), tmp, compression="zstd", row_group_size=100_000)
    for old in dirpath.glob("part-*.parquet"):
        old.unlink()
    os.replace(tmp, dirpath / "part-00000.parquet")


class Cleaner:
    def __init__(self, held: Path, model: str, batch: int):
        self.redactor = Redactor(HERE / "slurs.txt")
        self.model_name = model
        self.batch = batch
        self.tagger: Tagger | None = None  # loaded on first need; a fully resumed run never loads it
        self.label_dir = held / "_labels" / f"{model.replace('/', '--')}-{PROMPT_VERSION}"

    def _scrub(self, row: dict[str, Any], pii: Counter[str]) -> tuple[str, str]:
        """Redact the row in place; return (text, context) as redacted."""
        r = self.redactor
        text = r.redact(row["text"] or "", pii)
        row["text"] = text
        raw_meta = row.get("meta")
        context = ""
        try:
            meta = json.loads(raw_meta) if raw_meta else {}
        except json.JSONDecodeError:
            meta = None
        if isinstance(meta, dict):
            if isinstance(meta.get("context"), str):
                context = r.redact(meta["context"], pii)
                meta["context"] = context
            row["meta"] = json.dumps(meta, ensure_ascii=False)
        elif raw_meta:
            row["meta"] = r.redact(raw_meta, pii)
        if row.get("thread_name"):
            row["thread_name"] = r.redact(row["thread_name"], pii)
        for key, prefix in (("author", "person-"), ("thread_id", "thread-")):
            v = row.get(key)
            if v and r.redact(v, Counter()) != v:  # a phone or email handle: same pseudonym on every row
                row[key] = prefix + _digest(v)[:10]
                pii["[HANDLE]"] += 1
        return text, context

    def source(self, src: Path, out: Path, held: Path) -> dict[str, Any]:
        name = src.name
        t0 = time.monotonic()
        schema, rows = load_rows(src)
        pii: Counter[str] = Counter()
        labels: list[list[str] | None] = [None] * len(rows)
        threads: dict[str, list[Msg]] = defaultdict(list)
        ledger = Ledger(self.label_dir / f"{name}.jsonl")
        todo: set[int] = set()

        order = sorted(range(len(rows)), key=lambda i: (rows[i]["ts"] is not None, rows[i]["ts"] or 0))
        for i in order:
            row = rows[i]
            thread_key = row["thread_id"] or f"\x00{row['id']}"  # no thread: the row stands alone
            text, context = self._scrub(row, pii)
            h = _digest(text, context)
            row["_h"] = h
            if self.redactor.has_slur(text) or self.redactor.has_slur(context):
                labels[i] = ["slur"]
            elif not text.strip():
                labels[i] = ["ok"]
            elif (hit := ledger.get(row["id"], h)) is not None:
                labels[i] = hit
            else:
                todo.add(i)
            who = "me" if row["is_me"] else (row["author"] or "other")
            threads[thread_key].append(Msg(i, who, text, context))

        model_rows, model_secs = len(todo), 0.0
        if todo:
            log.info(
                "%s: %d rows, %d to label (%d already labelled)", name, len(rows), len(todo), len(rows) - len(todo)
            )
            model_secs = self._label(name, rows, threads, todo, labels, ledger)
        ledger.close()

        kept, flagged = [], []
        counts: Counter[str] = Counter()
        for row, lab in zip(rows, labels, strict=True):
            lab = sorted(lab or ["unlabeled"])
            counts.update(lab)
            row.pop("_h", None)
            row["labels"] = lab
            (kept if set(lab) <= KEEP else flagged).append(row)
        out_schema = schema.append(pa.field("labels", pa.list_(pa.string())))
        write_part(out / name, out_schema, sorted(kept, key=_order))
        write_part(held / name, out_schema, sorted(flagged, key=_order))
        return {
            "rows": len(rows),
            "kept": len(kept),
            "held": len(flagged),
            "labels": dict(counts),
            "pii": dict(pii),
            "model_rows": model_rows,
            "model_seconds": round(model_secs, 1),
            "rows_per_sec": round(model_rows / model_secs, 2) if model_secs else None,
            "seconds": round(time.monotonic() - t0, 1),
        }

    def _label(
        self,
        name: str,
        rows: list[dict[str, Any]],
        threads: dict[str, list[Msg]],
        todo: set[int],
        labels: list[list[str] | None],
        ledger: Ledger,
    ) -> float:
        if self.tagger is None:
            log.info("loading %s", self.model_name)
            self.tagger = Tagger(self.model_name, self.batch)
        tagger = self.tagger
        remaining: Counter[int] = Counter()  # pieces still unlabelled per row
        acc: dict[int, set[str]] = defaultdict(set)
        all_windows: list[Window] = []
        for msgs in threads.values():
            for w in windows(msgs, todo):
                all_windows.append(w)
                for key, _ in w.items:
                    remaining[key] += 1

        t0 = time.monotonic()
        done = 0
        for b in range(0, len(all_windows), self.batch):
            finished: list[tuple[str, str, list[str]]] = []
            for key, got in tagger.label(all_windows[b : b + self.batch]):
                acc[key] |= got
                remaining[key] -= 1
                if remaining[key] == 0:
                    lab = acc.pop(key)
                    final = sorted(lab - {"ok"} if lab - {"ok"} else {"ok"})
                    labels[key] = final
                    finished.append((rows[key]["id"], rows[key]["_h"], final))
            ledger.add(finished)
            done += len(finished)
            secs = time.monotonic() - t0
            s = tagger.speed
            log.info(
                "%s: %d/%d rows  %.1f rows/s  prompt %.0f tok/s  gen %.0f tok/s  peak %.1f GB",
                name,
                done,
                len(todo),
                done / secs if secs else 0.0,
                s.prompt_tps,
                s.generation_tps,
                s.peak_gb,
            )
        return time.monotonic() - t0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="inp", type=Path, required=True, help="mymemex export dir (<source>/part-*.parquet)")
    p.add_argument("--out", type=Path, required=True, help="kept rows; this is what may be uploaded")
    p.add_argument("--held", type=Path, required=True, help="held rows, labels ledger, summary; stays on this Mac")
    p.add_argument("--model", default=MODEL, help=f"mlx-lm model (default {MODEL})")
    p.add_argument("--batch", type=int, default=32, help="prompts in flight at once (default 32)")
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S", stream=sys.stderr)
    logging.getLogger("presidio-analyzer").setLevel(logging.WARNING)

    inp, out, held = a.inp.resolve(), a.out.resolve(), a.held.resolve()
    for x, y in ((out, held), (held, out), (out, inp), (inp, out), (held, inp)):
        if x == y or x.is_relative_to(y):
            sys.exit(f"--in, --out and --held must be separate trees ({x} is inside {y})")

    cleaner = Cleaner(held, a.model, a.batch)
    sources = sorted(d for d in inp.iterdir() if d.is_dir() and any(d.glob("part-*.parquet")))
    t0 = time.monotonic()
    per_source = {d.name: cleaner.source(d, out, held) for d in sources}
    model_rows = sum(s["model_rows"] for s in per_source.values())
    model_secs = sum(s["model_seconds"] for s in per_source.values())
    summary = {
        "model": a.model,
        "prompt_version": PROMPT_VERSION,
        "hold_labels": [*HOLD, "slur", "unlabeled"],
        "sources": per_source,
        "rows": sum(s["rows"] for s in per_source.values()),
        "kept": sum(s["kept"] for s in per_source.values()),
        "held": sum(s["held"] for s in per_source.values()),
        "model_rows": model_rows,
        "rows_per_sec": round(model_rows / model_secs, 2) if model_secs else None,
        "seconds": round(time.monotonic() - t0, 1),
    }
    held.mkdir(parents=True, exist_ok=True)
    (held / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
