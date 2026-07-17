---
description: Show JUDGED self-update advice for your standing glob/shadow policies (from the policy-auditor's dispositions) and, only when you explicitly choose to, apply a reversible demote-to-advisory. Read-only by default — nothing changes without an explicit, CAS-guarded apply.
argument-hint: "(no args — reports on the current project's policies)"
---

The user wants **self-update advice** for their standing glob/shadow policies: turn the
`policy-auditor`'s recorded **dispositions** into a per-policy recommendation (is a rule
flagging mostly-legit code, so it reads *too-broad*? or mostly-real problems, so it reads
*well-calibrated*?). Every recommendation is a **JUDGED estimate** — a heuristic read of
best-effort LLM dispositions, **NOT** a measured false-positive rate, NOT human-verified.

The single hard rule: **advice is auto-computed (read-only); APPLYING any change is an
explicit, user-invoked action.** Do exactly these steps:

1. **Compute the advice (read-only).** Call the MCP tool `policy_self_update_report` (no
   arguments beyond an optional `project`/`cwd`). It returns
   `{ kind, projectId, count, note, advisories: [ … ] }`. This tool **mutates nothing** —
   it never activates, deactivates, or edits a policy.
   - If the tool returns an error (e.g. the workspace can't be resolved), relay it and stop.
   - If `count === 0`, tell the user there are no active glob/shadow policies to advise, and
     suggest activating one (`/policy`) or adjudicating first (`/policy-adjudicate`). Stop.

2. **Present the advisories verbatim + honestly.** Show the top-level `note` verbatim (it
   discloses these are judged, heuristic, LOCAL, and that nothing changes without an explicit
   apply). For each advisory, present its `policyId`, `signal`
   (`too-broad` | `well-calibrated` | `insufficient-data`), `judged` numbers
   (`likelyFpShare`, `decisive`, `uncertain`, `total`, `source`), the `recommendation`
   string (which itself carries the judged-estimate caveat), and the `candidate.action`:
   - **`demote-to-advisory`** — the rule flags mostly-legit code (judged); it is a candidate
     to demote its shadow assertion back to a plain glob advisory. This is the ONLY thing
     you can apply here.
   - **`enforce-eligible`** — the rule mostly flags real problems (judged); it is
     **surfaced only** as eligible for a future enforce guard. **Enforcement is NOT
     implemented and is never applied here.** Do not offer to "turn on enforcement".
   - **`none`** — insufficient data or a middling/expected signal; nothing to apply. If the
     signal is `insufficient-data`, suggest `/policy-adjudicate` to gather more judgments.

3. **Only if the user EXPLICITLY asks to apply a demote:** call the MCP tool
   `policy_apply_candidate` with `{ policyId: "<id>", expectedSourceHash: "<the EXACT
   sourceHash for that policy from the report in step 1>" }`. Notes:
   - The `expectedSourceHash` is a **CAS guard**: pass the exact `sourceHash` shown for that
     policy in the report. If the policy changed since the report, the tool refuses and
     nothing is applied — re-run step 1 and retry with the current `sourceHash`.
   - The tool **refuses** unless the judged signal actually recommends the demote (you cannot
     force-demote a well-calibrated or insufficient-data policy), and it only ever removes
     the shadow assertion + enforcement (the globs + text are unchanged). It **never**
     promotes to enforce and **never** edits globs or literals.
   - The demote is **reversible**: re-activate the policy WITH its assertion (`/policy`) to
     restore the shadow measurement.
   - Show the tool's honest result verbatim (what changed, the ledger entry, the reversible
     note). Do **not** apply demotes in bulk or on the user's behalf without an explicit
     per-policy request.

Never mutate a policy that the user did not explicitly name for a demote. Never act on an
`enforce-eligible` signal. Communicate results in the user's preferred language (default
pt-BR). On Windows, use the PowerShell tool for any shell step.
