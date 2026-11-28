# Audit: Send to agent spec (agent-inbox.md), 2026-11-27

Method (spec-interrogation): Pass A, a fresh-eyes implementer subagent that saw only the spec, found
22 findings. Pass B compared the conversation with the spec. Pass C mapped 38 seams and ran a 14-agent
Sonnet swarm over them. **Seams checked: 38. Held: 1** (S2, the pull-only architecture). Every other
seam had at least one finding. All findings were checked against the spec and the code, then
deduplicated. The table lists each finding cluster and where v2 resolves it.

## Would build the wrong thing

| # | Finding (sources) | Resolution in v2 |
|---|---|---|
| W1 | Linking by `ppid` fails on the documented `npx` install, so almost every agent would show as unlinked (A1, S3, S8, S35) | **Resolved** by AD4: walk up the process tree to the `claude`/`codex` ancestor. P0 item 1 verifies it. |
| W2 | Nothing gave the bridge a signal that Claude was launched with channels. Declaring the capability is not proof of it, and the "client advertises support" trigger doesn't exist (A2, S12, S13, S9) | **Resolved** by AD9: the proxy reads the agent's argv and reports it. The route stays gated until P0 confirms it. The "client advertises" clause is cut. |
| W3 | "Delivered" was not observable on any route. Feed states and session statuses shared one vocabulary (A3, S10, S25, S33) | **Resolved** by AD7: delivery states defined by what the bridge can see, plus an `agent.status` event. The glossary separates `status` from delivery state. |
| W4 | A REST `GET /v1/agents` (and by implication a REST send) is reachable by every local secret holder, which bypasses the panel-only control (A4, S6, S28, S29) | **Resolved** by AD2: WebSocket only, no REST route. |
| W5 | Any secret or token holder could subscribe to another session's inbox stream (A5, S28, S29) | **Resolved** by AD5: streams keyed by `restKey`, one per key. The residual risk for secret holders is **accepted** as AR1, because it matches DESIGN D1. |
| W6 | The tab grant contradicted D9/D18(f) and left these undefined: cross-session tabs, private tabs, tabs in handoff, the `attached` flag, ordering, failure handling, and a lazy session/group (A6, S1, S20, S21, S22, S23) | **Resolved** by AD11: an explicit amendment, an ordered grant/ack flow, a list of refusals, `attached: true`, and `getSession(meta)`. |
| W7 | Agent `id` was undefined. The Claude `sessionId` is shared by two pids, and Codex threads have no pid (A14, S7, S8, S11, S16) | **Resolved** by AD3. |
| W8 | Codex↔TabAgent linking had no workable join, because the app-server Thread has no pid (A8, S17, S38) | **Cut for v1** by AD4. Listed as a non-goal. |
| W9 | Page-controlled title and URL sat outside PAGE_DATA. The wrapper's meaning was unexplained on non-MCP routes (A13, S19) | **Resolved** by AD12: title, URL and selection are wrapped, the message carries one line explaining the wrapper, and one nonce is chosen across the whole message. |
| W10 | The piggyback layer (daemon or proxy), result shape, trust framing, TTL and cancel were all unspecified (A10, S4, S14, S15, S18) | **Resolved** by AD8. Residual risk **accepted** as AR2. |
| W11 | The `agent.send` payload, the reply, failure ownership, and which side composes the message were all undefined (S18, S25, S6) | **Resolved** by §6 and AD12. |
| W12 | The context menu → panel hand-off and the tab binding were undefined. The selection from one tab could be sent with a different tab (S24) | **Resolved** by AD14: a pending intent in storage, plus the tab-switch rule. |
| W13 | The phase plan had no route for the most common case in P1. The grant and the badge were in different phases. Codex discovery and the limits had no phase (A11, S36) | **Resolved** by the §10 rewrite: every stage has its scope and a testable exit. |
| W14 | The Codex "queued vs running" status had no mapping to app-server `ThreadStatus` values, and the thread id format was unspecified (S16, S17) | **Resolved** by AD10. OT4 covers the parts that need the spike. |
| W15 | Plugin channel syntax was wrong. The allowlist is required even when TabAgent ships as a plugin (S27) | **Parked** as OT5, with the correct `plugin:tabagent@<marketplace>` syntax. |

## Would force a guess

| # | Finding | Resolution |
|---|---|---|
| G1 | Startup report had no carrier or auth, and sessions are created lazily (A7, S3, S29) | AD4 headers. Opening the stream creates the session eagerly. |
| G2 | Inbox reconnect, message loss and ack were undefined (A12, S4) | AD5 |
| G3 | Bypass-permissions confirm step had no data source (A9, S21, S30, S31) | **Cut** (non-goal, with a trigger) |
| G4 | Audit record shape, writer, hashed input, and logging the raw URL (A16, S30) | AD15 |
| G5 | Size limits had no numbers (A17, S16, S18) | AD13 |
| G6 | `claude --bg` has no cwd flag; spawn's template, outcome and permission mode were undefined (S15) | §6 |
| G7 | Discovery source failures, CLI timeout and maxBuffer (S7, S11, S17) | §5 |
| G8 | The Sessions and Agents lists overlap ("No agents connected."), and refresh was undefined (S5) | §7 |
| G9 | Feature negotiation with an old bridge (S6) | AD16 |
| G10 | Kill switch versus sends (S30) | AD17 |
| G11 | `canDriveTab` was conflated with "has a session" (S38) | Glossary: linked vs canDriveTab |
| G12 | The channel permission relay could be triggered implicitly (S32) | AD9 (ignore and audit) plus a non-goal |
| G13 | "Recent agents" was undefined (S24) | §7 |
| G14 | A prompt beginning with `-` would be read as a CLI flag (A20) | AD13: the text always starts with `[` |

## Polish

- Paths were missing the `packages/` prefix. Fixed in §3.
- The Goal overclaimed "no second permission prompt". Reworded (§1, AD11).
- "Only the side panel" is enforced at extension-page granularity. Restated in AD14.
- Removed machine-specific details (local session names, private tooling), because the repo is public.

## Conversation versus spec (Pass B)

- The user asked to prompt agents "from page in my browser". v1 delivers this through the side panel and the context menu. An injected on-page widget is now an explicit **non-goal** with a trigger, so it isn't built by default.
- The draft had no numbered decisions, no non-goals, no glossary, no accepted risks and no stage exits. All are added.

## Handoff readiness

P0 can start now. P1 can be implemented without questions whose answers are already known. P2 and P3
depend on the load-bearing threads OT1 and OT2, which P0 answers.
