"""Model pass: a local open model, run through mlx-lm on the Mac, labels each row. Nothing leaves the machine.

Rows of one thread are labelled together in windows (up to WINDOW_ITEMS rows), with a few neighbouring
messages shown for judgment only. A row longer than ITEM_CHARS is split into pieces; each piece is labelled
and the row takes the union. Output is one JSON object per window. A row the model fails to answer for is
retried alone, then labelled "unlabeled" (held): the filter fails closed.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

from mlx_lm import batch_generate, load

# Qwen3.6-35B-A3B at 4-bit: newest strong open instruct model that fits 48 GB (about 20 GB of weights);
# 3B active parameters per token, so it runs at small-model speed with mid-size-model judgment.
MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit"
PROMPT_VERSION = "v1"  # bump when the policy below changes; the label ledger is keyed by it

HOLD = ("sexual", "deep_personal", "third_party_private")
LABELS = (*HOLD, "ok")

ITEM_CHARS = 3000  # a row longer than this is labelled in pieces
WINDOW_ITEMS = 20  # labelled pieces per prompt (amortizes the ~330-token policy over short messages)
WINDOW_CHARS = 9000  # labelled text per prompt
NEIGHBOURS_BEFORE = 3
NEIGHBOURS_AFTER = 2
NEIGHBOUR_CHARS = 400
CONTEXT_CHARS = 800  # tail of meta.context (the assistant turn he was answering) shown with a row
TOKENS_PER_ITEM = 24

POLICY = """You screen messages from one person's personal data (chats, AI conversations, notes, \
documents, shell history). The rows you pass will train a model of his voice; rows you flag stay \
private and are never used. "[me]" marks his own messages; other names are other people.

Give each numbered row one or more labels:
- sexual: sexual acts, desire, nudity, sexting, explicit or suggestive talk, or sexual gray-area \
content. Swearing alone ("fuck", "shit", "fucking hell") is NOT sexual.
- deep_personal: intimate detail about him or anyone close: physical or mental health, diagnoses, \
therapy, medication, family or relationship conflict, breakups, trauma, abuse, grief, personal money \
(debt, salary, net worth, money troubles), legal trouble. Everyday mentions are not: being tired, \
dinner with family, buying a laptop, business or project costs.
- third_party_private: reveals another person's private life or secrets: their health, relationships, \
money, confessions, things said in confidence, gossip about someone's private matters.
- ok: none of the above. Normal talk, work, code, opinions, jokes and swearing are ok.

Judge each row by what it says, using the neighbouring messages only to understand it. A row that \
only makes sense as part of a flagged exchange gets the same label. When a row clearly touches one of \
the three categories, flag it; do not flag ordinary life.

Reply with only a JSON object mapping every row number to a list of labels, for example \
{"1": ["ok"], "2": ["deep_personal"], "3": ["sexual", "third_party_private"]}."""


@dataclass
class Msg:
    key: int  # caller's row index
    who: str  # "me" or the other person's name/pseudonym
    text: str  # already redacted
    context: str  # already redacted meta.context, "" if none


@dataclass
class Window:
    before: list[str]
    items: list[tuple[int, str]]  # (row key, rendered piece)
    after: list[str]


def _short(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 3] + "..."


def pieces_of(m: Msg) -> list[str]:
    chunks = [m.text[i : i + ITEM_CHARS] for i in range(0, len(m.text), ITEM_CHARS)] or [""]
    out = []
    for j, ch in enumerate(chunks):
        head = f"[{m.who}]" + (f" (part {j + 1} of {len(chunks)})" if len(chunks) > 1 else "")
        tail = ""
        if j == 0 and m.context:
            said = _short(m.context[-CONTEXT_CHARS:], CONTEXT_CHARS)
            tail = f'\n   (he was answering an assistant that had said: "{said}")'
        out.append(f"{head} {ch}{tail}")
    return out


def windows(thread: list[Msg], todo: set[int]) -> Iterator[Window]:
    """Windows over the rows of one thread (in order) whose key is in `todo`."""

    def neighbours(lo: int, hi: int) -> list[str]:
        return [f"[{m.who}] {_short(m.text, NEIGHBOUR_CHARS)}" for m in thread[max(lo, 0) : max(hi, 0)]]

    items: list[tuple[int, str]] = []
    first = last = 0
    size = 0
    for pos, m in enumerate(thread):
        if m.key not in todo:
            continue
        for piece in pieces_of(m):
            if items and (len(items) >= WINDOW_ITEMS or size + len(piece) > WINDOW_CHARS):
                yield Window(
                    neighbours(first - NEIGHBOURS_BEFORE, first),
                    items,
                    neighbours(last + 1, last + 1 + NEIGHBOURS_AFTER),
                )
                items, size = [], 0
            if not items:
                first = pos
            items.append((m.key, piece))
            last = pos
            size += len(piece)
    if items:
        yield Window(
            neighbours(first - NEIGHBOURS_BEFORE, first), items, neighbours(last + 1, last + 1 + NEIGHBOURS_AFTER)
        )


def _user_turn(w: Window) -> str:
    parts = []
    if w.before:
        parts.append("Earlier messages (context only, do not label):\n" + "\n".join(w.before))
    parts.append("Rows to label:\n" + "\n".join(f"<{i}> {text}" for i, (_, text) in enumerate(w.items, 1)))
    if w.after:
        parts.append("Later messages (context only, do not label):\n" + "\n".join(w.after))
    parts.append(f"Answer with the JSON object for rows 1 to {len(w.items)}.")
    return "\n\n".join(parts)


def parse(text: str, n: int) -> dict[int, set[str]]:
    """Row number -> labels, for rows the model answered validly; anything malformed is left out."""
    s = text.split("</think>")[-1]
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        obj = json.loads(s[i : j + 1])
    except json.JSONDecodeError:
        return {}
    if not isinstance(obj, dict):
        return {}
    out: dict[int, set[str]] = {}
    for k, v in obj.items():
        try:
            idx = int(str(k).strip("<> "))
        except ValueError:
            continue
        vals = [v] if isinstance(v, str) else v if isinstance(v, list) else []
        labels = {x for x in vals if isinstance(x, str) and x in LABELS}
        if 1 <= idx <= n and labels:
            out[idx] = labels - {"ok"} if labels & set(HOLD) else labels
    return out


@dataclass
class Speed:
    prompt_tps: float = 0.0
    generation_tps: float = 0.0
    peak_gb: float = 0.0


class Tagger:
    def __init__(self, model: str = MODEL, batch: int = 32):
        loaded = load(model)
        self.model, self.tok = loaded[0], loaded[1]
        self.batch = batch
        self.speed = Speed()

    def _generate(self, ws: list[Window]) -> list[str]:
        prompts = [
            self.tok.apply_chat_template(
                [{"role": "system", "content": POLICY}, {"role": "user", "content": _user_turn(w)}],
                add_generation_prompt=True,
                enable_thinking=False,
            )
            for w in ws
        ]
        r = batch_generate(
            self.model,
            self.tok,
            prompts=prompts,  # type: ignore[arg-type]  # token ids when tokenize=True
            max_tokens=[TOKENS_PER_ITEM * len(w.items) + 16 for w in ws],
            completion_batch_size=self.batch,
            prefill_batch_size=min(8, self.batch),
        )
        s = r.stats
        self.speed = Speed(s.prompt_tps, s.generation_tps, s.peak_memory)
        return r.texts

    def label(self, ws: list[Window]) -> list[tuple[int, set[str]]]:
        """One (row key, labels) per piece, in window order. Pieces the model never answered get {"unlabeled"}."""
        out: list[tuple[int, set[str]]] = []
        retry: list[Window] = []
        for w, text in zip(ws, self._generate(ws), strict=True):
            got = parse(text, len(w.items))
            for i, (key, piece) in enumerate(w.items, 1):
                if i in got:
                    out.append((key, got[i]))
                else:
                    retry.append(Window(w.before, [(key, piece)], w.after))
        if retry:
            for w, text in zip(retry, self._generate(retry), strict=True):
                got = parse(text, 1)
                out.append((w.items[0][0], got.get(1, {"unlabeled"})))
        return out
