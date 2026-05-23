#!/usr/bin/env node
/**
 * Refine Research — Stop hook.
 *
 * Always fires after every LLM response. Injects a reminder asking the LLM
 * to research and answer its own pending questions instead of waiting for
 * the user to respond.
 *
 * The LLM (via octopus.agent.md instructions) knows if it asked questions
 * in its previous response. The hook just reminds it to take action.
 *
 * No detection logic needed — the LLM handles everything.
 */
(async () => {
  try {
    const raw = await new Promise(resolve => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data));
    });

    if (!raw) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const event = JSON.parse(raw);
    if (event.hook_event_name && event.hook_event_name !== 'Stop') {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    // Always inject: remind LLM to answer pending questions
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `[refine] If you asked questions in your previous response, research the answers now using project files (Read, Grep, Glob) and web search (WebSearch, WebFetch). Do NOT wait for the user to answer — resolve the gaps yourself. Provide the answers and proceed with the task.`,
      },
    }));
  } catch (err) {
    console.error(`[REFINE-RESEARCH] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
