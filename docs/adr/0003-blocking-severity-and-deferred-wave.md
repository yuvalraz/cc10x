# Blocking Severity and the Deferred Wave

From 12.11 only CRITICAL and HIGH findings, plus the non-severity gates that
already blocked, stop a BUILD phase. One REM-FIX takes the whole blocking set
with `scope:ALL_ISSUES`, and the router asks no scope question. MEDIUM and LOW
findings go to `deferred_findings`, and BUILD-DONE fixes the MEDIUMs in one
deferred wave before the mandatory final review.

## Context

Before 12.11 the router asked `Fix critical only` or `Fix all issues` whenever a
BUILD review raised CRITICAL and HIGH together (rule `1a-SCOPE`), asked again
when the reviewer approved but the hunter reported HIGH (rule 2), and
auto-created a REM-FIX for every non-blocking item (rule 1b). Each answer cost a
round trip, a critical-only fix left the HIGH issues for another cycle, and
MEDIUM findings either blocked a phase through rule 1b or slipped into Memory
Notes `**Deferred:**` and were never fixed. The failure-hunter's findings
carried no per-finding severity, so the router could not tell a MEDIUM from a
coverage note.

## Decision

- **Blocking set (D1).** Every validated CRITICAL and HIGH finding from
  `code-reviewer`, `failure-hunter` and `integration-verifier` (after
  post-verifier finding validation), plus a non-PASS `SPEC_COMPLIANCE`, an
  unresolved `CANNOT_VERIFY_CROSS_PHASE`, a verifier `FAIL` and a missing or
  false TDD RED/GREEN. CRITICAL comes from `### Critical Issues`; HIGH from the
  reviewer's `### Findings` entries with `Severity: HIGH` and from the hunter's
  `HIGH_ISSUES` field and `Severity: HIGH` entries. The verifier rates no
  severity; its `### Findings` are observations. Notes (the hunter's
  `### Coverage`) are not findings. An entry under `### Findings` with a missing
  or unknown severity blocks (fail closed).
- **One wave (D2).** A BUILD REM-FIX always takes the whole blocking set with
  `scope:ALL_ISSUES`. `CRITICAL_ONLY` stays in the `scope:` enum and in
  `REMEDIATION_SCOPE_REQUESTED` only so pre-12.11 tasks parse; a legacy
  `[SCOPE-DECISION-PENDING]` marker resumes as an `ALL_ISSUES` REM-FIX.
- **Envelope unchanged (D3).** The line-1 envelope `b`/`cr` keep counting
  CRITICAL only; the router computes the blocking set from severities, never
  from `b`.
- **Deferred entries (D4).** `deferred_findings` entries are
  `{source, phase_id, finding, severity}` with `severity` one of `medium`, `low`
  or `minor`. BUILD writes `medium` or `low`; `minor` stays valid for QA and
  older artifacts. DEBUG keeps auto-creating a REM-FIX for non-blocking items,
  and REVIEW keeps its ask.
- **BUILD-DONE order (D10).** A standard build runs one deferred wave over the
  `medium` entries, then the mandatory final whole-branch review (its CRITICAL
  and HIGH get one fix wave), then the single finishing ask listing every LOW
  and any MEDIUM left over. Trivial builds list their deferred items only.

## Rejected alternatives

- **Keep the scope question.** Rejected: it paused every mixed review for a
  user answer, and a critical-only answer only moved the HIGH issues to the next
  cycle.
- **Block on every severity.** Rejected: MEDIUM and LOW findings would each cost
  a full remediation cycle inside the phase, the loop the change set out to
  tighten.
- **Defer MEDIUM and LOW without a wave.** Rejected: a real defect rated MEDIUM
  would never be fixed; the deferred wave at BUILD-DONE closes it once, for the
  whole branch.
- **Count HIGH in the envelope.** Rejected: `b`/`cr` are a fast-path signal many
  checks already read as CRITICAL-only; changing them would ripple through every
  agent contract for no gain over reading severities.

## Consequences

- Rules `1a-SCOPE` and the §4 scope prompt are gone; the `Scope-decision resume:`
  label stays for legacy markers.
- The failure-hunter writes a `Severity:` line per finding and moves coverage,
  pattern and step-9 notes to `### Coverage`, so the fail-closed rule never
  blocks a note.
- The agents' Memory Notes `**Deferred:**` line carries non-finding follow-ups
  only, so a MEDIUM fixed by the wave is not also written to `patterns.md`.
- The verifier handoff passes `**High Issues:**` for both agents, so every HIGH
  in the blocking set is validated.
- Replay fixture `build-scope-gate.json` now expects `create_remfix` with
  `ALL_ISSUES` and no pending gate; INV-005 is the whole-blocking-set rule.
- The deferred wave and the final review land in a later phase of the same
  release (12.11.0).
