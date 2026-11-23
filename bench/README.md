# Benchmark

Twenty scripted-goal tasks (#24) on the fixture site in [`fixtures/`](fixtures): forms, tables,
pagination, modals, JS dialogs, iframes, shadow DOM, popups, delayed content, downloads and a
multi-page checkout. Each task has a programmatic end-state checker in [`tasks.mjs`](tasks.mjs).
The task set is versioned (`TASK_SET_VERSION`); bump it when a task, fixture or checker changes.

## End state

Fixture pages write what happened to `localStorage["bench"]`. After the agent stops, the runner
records `{url, title, text, bench, answer}` from the last session tab on the fixture origin
(`answer` is the agent's final message, used by lookup tasks) and hands it to the checker.

## Running

```bash
npm run bench -- --dry-run                     # scripted fake agent + recorded states, no browser/model
npm run bench -- --dry-run --fail dialog-prompt  # see a failing row
npm run build && npm run bench -- --agent claude-code --model <model> --out results.md
```

Real runs use the e2e harness (#22): Chromium with the unpacked extension, a bridge on a temp port
and home, real pairing, fixture origins pre-granted and `devAllowSensitive` on. Tasks use the
`core` profile unless they say otherwise. Comparisons with other browser MCP servers must use the
same tasks, model and `--max-steps`. The [`bench` workflow](../.github/workflows/bench.yml) runs
this manually with `ANTHROPIC_API_KEY`; it is never a required check.

## Results table

| Column | Meaning |
|---|---|
| agent, model, date, task-set | who ran what, when, against which task-set version |
| success | `pass`, or `FAIL: <checker reason>` |
| calls | TabAgent tool calls (other tools are not counted) |
| tokens (model) | input + output tokens the model provider reported, cache reads/writes included |
| tokens (chars/4) | `ceil(chars / 4)` of TabAgent tool output text (the project's token unit, D23) |

## Tests

`bench/test/` (part of `npm test`): every checker passes its recorded passing state and fails its
recorded failing state ([`recorded/states.json`](recorded/states.json)); the dry run produces the
table and marks failures; the metrics collector is checked against a recorded Claude Code
transcript.

## Published runs

None yet. The first full run goes in the top-level README with model, date and task-set version.
