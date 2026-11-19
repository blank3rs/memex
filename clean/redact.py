"""Deterministic pass: PII spans become typed placeholders; a slur holds the row.

Presidio does the span finding (its validated recognizers for phone, email, card, SSN, SIN, IBAN, plus
our context-anchored patterns for addresses, 2FA codes, passwords and account numbers). No NLP model is
loaded and nothing touches the network: the email validator reads tldextract's bundled suffix snapshot.
API keys and private keys are already dropped by `mymemex export` (src/export/redact.ts).
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import regex as re
import tldextract
from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer, RecognizerRegistry
from presidio_analyzer.nlp_engine import NoOpNlpEngine
from presidio_analyzer.predefined_recognizers import (
    CaSinRecognizer,
    CreditCardRecognizer,
    EmailRecognizer,
    IbanRecognizer,
    PhoneRecognizer,
    UsSsnRecognizer,
)
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

# Presidio entity -> placeholder written into the text.
PLACEHOLDER = {
    "PHONE_NUMBER": "[PHONE]",
    "EMAIL_ADDRESS": "[EMAIL]",
    "CREDIT_CARD": "[CARD]",
    "US_SSN": "[SSN]",
    "CA_SIN": "[SIN]",
    "IBAN_CODE": "[ACCOUNT]",
    "ACCOUNT_NUMBER": "[ACCOUNT]",
    "GOV_ID": "[ID]",
    "STREET_ADDRESS": "[ADDRESS]",
    "OTP_CODE": "[CODE]",
    "PASSWORD": "[PASSWORD]",
}

SCORE_THRESHOLD = 0.4  # drops Presidio's bare-digit "weak" SSN pattern (0.05); phone is 0.4

_STREET_SUFFIX = (
    r"street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|crescent|cres|place|pl|"
    r"terrace|terr|circle|cir|parkway|pkwy|highway|hwy|trail|trl|square|sq|close|grove|gardens|gate|row|"
    r"sideroad|concession|line|mews|heights|hts|private|pvt"
)
# Global flags are IGNORECASE | DOTALL | MULTILINE (Presidio's default); (?-i:...) re-enables case where a
# capital letter is the signal. Lookbehinds keep the cue word in the text and replace only the value.
_CUSTOM: dict[str, list[Pattern]] = {
    "STREET_ADDRESS": [
        Pattern(
            "street",
            r"\b\d{1,6}[a-z]?(?:-\d{1,6})?,?\s+(?:(?-i:[A-Z0-9][\w'.-]*)\s+){1,4}"
            rf"(?:{_STREET_SUFFIX})\b\.?(?:\s+(?-i:[NSEW]|North|South|East|West)\b)?"
            r"(?:,?\s*(?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)?",
            0.6,
        ),
        Pattern("unit-first", r"\b(?:apt|apartment|unit|suite|ste)\.?\s*[\w-]+\s*[,-]\s*\d{1,6}\s+(?-i:[A-Z])\w+", 0.6),
        Pattern("po-box", r"\bP\.?\s?O\.?\s*Box\s+\d+", 0.7),
        Pattern("ca-postal", r"(?-i:\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b)", 0.6),
        Pattern("us-state-zip", r"(?<=,\s*)(?-i:[A-Z]{2})\s+\d{5}(?:-\d{4})?\b", 0.6),
    ],
    "OTP_CODE": [
        Pattern(
            "cue-then-code",
            r"(?<=\b(?:(?:verification|security|login|log-in|sign-?in|auth|authentication|confirmation|access|"
            r"one[- ]time|your(?:\s+\w+)?)\s*(?:code|pin|passcode)|(?:2fa|mfa|otp|passcode|pin)(?:\s*code)?)"
            r"\s*(?:is|was|:|=|-)?\s*)(?:\d{4,8}|\d{3}[ -]\d{3})\b",
            0.7,
        ),
        Pattern(
            "code-then-cue",
            r"\b(?:\d{4,8}|\d{3}[ -]\d{3})(?=\s+is\s+your\b[^\n]{0,40}\b(?:code|pin|otp|passcode)\b)",
            0.8,
        ),
        Pattern("google-style", r"\b(?-i:G)-\d{5,6}\b", 0.8),
    ],
    "PASSWORD": [
        Pattern(
            "explicit",
            r"(?<=\b(?:password|passwd|pwd|passphrase|passcode|pw|wifi pass(?:word)?|wi-fi pass(?:word)?)"
            r"\s*[:=]\s*[\"'`]?)[^\s\"'`]{3,}",
            0.7,
        ),
        Pattern(
            "is-value",
            r"(?<=\b(?:password|passwd|passphrase|passcode|pw|pass)\s+(?:is|was)\s+[\"'`]?)"
            r"(?=[^\s\"'`]*[\d!@#$%^&*_])[^\s\"'`]{4,}",
            0.7,
        ),
    ],
    "ACCOUNT_NUMBER": [
        Pattern(
            "cued",
            r"(?<=\b(?:account|acct|a/c|routing|transit|institution|chequing|checking|savings|member|policy|"
            r"card|client|customer)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*)\d[\d -]{4,22}\d\b",
            0.7,
        ),
    ],
    # Government IDs written after their name, checksum or not (Presidio's SIN/SSN need a valid shape).
    "GOV_ID": [
        Pattern(
            "cued",
            r"(?<=\b(?:sin|ssn|social insurance|social security|health card|ohip|driver'?s? licen[cs]e|licen[cs]e|"
            r"passport)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*)[a-z]?\d[\d -]{4,22}[\da-z]\b",
            0.75,
        ),
    ],
}


class _OfflineEmailRecognizer(EmailRecognizer):
    """Presidio's email recognizer, but the domain check reads the bundled suffix list (no network)."""

    _tld = tldextract.TLDExtract(suffix_list_urls=())

    def validate_result(self, pattern_text: str) -> bool:
        return self._tld(pattern_text).fqdn != ""


def _analyzer() -> AnalyzerEngine:
    registry = RecognizerRegistry(supported_languages=["en"])
    for rec in (
        PhoneRecognizer(),
        _OfflineEmailRecognizer(),
        CreditCardRecognizer(),
        UsSsnRecognizer(),
        CaSinRecognizer(),
        IbanRecognizer(),
    ):
        registry.add_recognizer(rec)
    for entity, patterns in _CUSTOM.items():
        registry.add_recognizer(PatternRecognizer(supported_entity=entity, patterns=patterns, name=entity.lower()))
    nlp = NoOpNlpEngine(models=[{"lang_code": "en", "model_name": "none"}])
    return AnalyzerEngine(registry=registry, nlp_engine=nlp, supported_languages=["en"])


_PASSWORD_CUE = re.compile(r"pass|pw", re.IGNORECASE)


class Redactor:
    def __init__(self, slur_file: Path):
        self._analyzer = _analyzer()
        self._anonymizer = AnonymizerEngine()
        self._operators = {e: OperatorConfig("replace", {"new_value": p}) for e, p in PLACEHOLDER.items()}
        self._entities = list(PLACEHOLDER)
        words = [
            ln.strip() for ln in slur_file.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")
        ]
        self._slur = re.compile(r"(?<![a-z0-9])(?:" + "|".join(words) + r")(?![a-z0-9])", re.IGNORECASE)

    def redact(self, text: str, counts: Counter[str]) -> str:
        """Replace PII spans with placeholders; add one count per placeholder written."""
        # Every entity needs a digit or an '@', except a password with a cue word.
        if not text or not (any(c.isdigit() for c in text) or "@" in text or _PASSWORD_CUE.search(text)):
            return text
        found = self._analyzer.analyze(
            text=text, language="en", entities=self._entities, score_threshold=SCORE_THRESHOLD
        )
        if not found:
            return text
        result = self._anonymizer.anonymize(text=text, analyzer_results=found, operators=self._operators)  # type: ignore[arg-type]
        for item in result.items:
            counts[PLACEHOLDER.get(item.entity_type, item.entity_type)] += 1
        return result.text or ""

    def has_slur(self, text: str) -> bool:
        return bool(text) and self._slur.search(text) is not None
