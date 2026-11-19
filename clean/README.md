# clean: privacy filter for `mymemex export`

Runs on the Mac. Reads the export's Parquet, writes a cleaned copy that may be uploaded for training, and keeps
everything flagged on the Mac. No text goes to any API; the only network use is the one-time install and model
download.

```
clean/bootstrap.sh                       # once: uv, Python 3.12, locked deps, model weights (~20 GB)
uv run clean/memex_clean.py --in ~/memex-export --out ~/memex-clean --held ~/memex-held
```

- `--out/<source>/part-00000.parquet`: kept rows, export schema plus `labels` (always `["ok"]`). Upload this only.
- `--held/<source>/part-00000.parquet`: held rows with their labels: `sexual`, `deep_personal`,
  `third_party_private`, `slur`, `unlabeled` (the model gave no valid answer; the filter fails closed).
- `--held/summary.json`: rows, kept, held, label and placeholder counts per source; model rows/sec.
- `--held/_labels/`: label ledger. A stopped run resumes; an edited row is labelled again. Delete it to relabel.

What it removes:
- Placeholders, in text, `meta.context`, `thread_name`: `[PHONE] [EMAIL] [ADDRESS] [CARD] [ACCOUNT] [SSN] [SIN] [ID]
  [CODE] [PASSWORD]` (Microsoft Presidio, no NLP model, offline). Phone/email handles in `author` and `thread_id`
  become stable pseudonyms. API keys and private keys are already dropped by the export itself.
- Slurs: `slurs.txt` (regex per line) holds the row. Swearing is kept.
- Model labels: `mlx-community/Qwen3.6-35B-A3B-4bit` through mlx-lm, rows judged in thread windows with
  neighbouring messages. Policy text and window sizes: `tagger.py`; bump `PROMPT_VERSION` when the policy changes.

Each run rewrites the outputs from all input parts (the newest copy of an id wins); only unlabelled rows reach
the model, so incremental exports cost only their new rows.
