---
description: Adjudicate a glob/shadow policy's CURRENT-code occurrences with the policy-auditor judge (honest LLM snapshot disposition — NOT a false-positive rate).
argument-hint: "<policyId>  (from /policy list or policy_list)"
---

The user wants to **adjudicate** a standing glob/shadow policy: have the `policy-auditor`
sub-agent judge whether the code the policy currently matches is consistent with the
policy's stated intent. The result is an honest **current-snapshot occurrence disposition**
— a best-effort LLM judgment of the CURRENT code, **NOT** a measured false-positive rate,
NOT human-verified, and it changes NOTHING about the policy (no rule mutation, no
enforcement).

The policy id is: `$ARGUMENTS`

You are the ORCHESTRATOR. The trusted MCP tools build the evidence and record the verdict;
the sub-agent judges. **Do NOT gather occurrences or build the bundle yourself** — that is
the `policy_adjudication_prepare` tool's job. Do exactly these steps:

1. **Prepare the evidence bundle.** Call the MCP tool `policy_adjudication_prepare` with
   `{ policyId: "<the id from $ARGUMENTS>" }`. It returns
   `{ bundlePath, manifestHash, occurrenceCount, intent, note }`.
   - If `$ARGUMENTS` is empty, ask the user for a policy id (from `policy_list`) and stop.
   - If the tool returns an error (e.g. the id is not a glob policy, or the workspace can't
     be resolved), relay that message to the user and stop.

2. **Disclose + short-circuit.** Show the user the `note` verbatim (it discloses that
   redacted code context will be sent to the model provider when the judge runs). If
   `occurrenceCount === 0`, tell the user "no current occurrences to adjudicate" and stop —
   do not spawn the judge.

3. **Spawn the judge.** Use the **Task tool** with `subagent_type: policy-auditor` (the
   scoped name `claude-code-boss:policy-auditor` also works). Instruct it to:
   - `Read` ONLY the file at `bundlePath` (pass the exact path). It must read nothing else.
   - Judge every occurrence and return its **strict JSON** verdict object
     (`{ "schema": 1, "verdicts": [ … ] }`) and nothing else.
   Capture the sub-agent's raw JSON output as `verdictsJson`. Do NOT edit or re-key it.

4. **Record the verdict.** Call the MCP tool `policy_adjudication_record` with
   `{ policyId: "<id>", manifestHash: "<from step 1>", verdictsJson: "<the judge's raw JSON>" }`.
   - If it returns an error (schema invalid, or ids don't match the bundle — unknown /
     duplicate / missing occurrence ids), relay the exact error to the user and stop. It
     will NOT persist a malformed disposition; you may re-run the judge once, then stop.

5. **Present the disposition.** Show the honest disposition summary from
   `policy_adjudication_record` **verbatim** — it already carries the `disclaimer`
   (current-snapshot judgment, not a false-positive rate, code sent to the provider) and,
   when applicable, an INFORMATIONAL-ONLY `tuningRecommendation`. Do **not** act on the
   tuning text automatically: never change the policy's globs/literal, never deactivate it,
   never promote it to enforce. Any tuning is the user's explicit call.

Communicate results in the user's preferred language (default pt-BR). On Windows, use the
PowerShell tool for any shell step.
