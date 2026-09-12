# Exit Compass Lite

Exit Compass is a one-script Ambiguous coworker for the moment an account manager leaves. It reads synthetic Maya Chen / Acme Corp evidence across Mail, CRM, Tasks, Docs, and Calendar, asks OpenAI for one strictly validated risk plan, writes an evidence-linked handoff brief and an unsent client-update draft, then waits for explicit manager approval before creating exactly three tasks.

The workspace is the interface. There is no frontend, database, or automatic client communication.

## Setup

Requirements: Node 18+ (native `fetch`) and an Ambiguous agent workspace. The Ambiguous CLI can provision one with:

```bash
npx ambiguous auth signup --name "Exit Compass" --human-email YOUR_EMAIL
```

Copy the environment template and add secrets locally:

```bash
cp .env.example .env
npm install
```

Set `AMBIGUOUS_API_KEY` to the agent key from the Ambiguous CLI and `OPENAI_API_KEY` to an OpenAI API key. `AMBIGUOUS_INBOX_ADDRESS` is optional and defaults to the non-deliverable synthetic address `exit-compass@example.com`; the seed uses the documented Mail send endpoint only to create synthetic evidence, never to contact a real client.

## Run the demo

```bash
npm run seed
npm run run
npm run approve
```

The approval script is hard-coded to require `APPROVE_ACME_HANDOFF`; a different phrase is rejected. `run.json` stores only returned workspace IDs and artifact URLs, so the script can reread the exact seeded records and avoid duplicate runs. Delete or reset `run.json` only when you intentionally want a fresh synthetic scenario in a workspace.

`seed` creates:

- three synthetic Acme/Maya email messages through `POST /api/mail/send`;
- two open Maya tasks through `POST /api/tasks`;
- one Acme CRM contact through `POST /api/crm/contacts`;
- one Acme renewal meeting through `POST /api/calendar/events`;
- one internal delivery note through `POST /api/documents`.

`run` reads only the persisted mail/task/document IDs plus the bounded CRM contacts and Calendar event lists, then calls OpenAI once. It creates `Acme Handoff Brief — Maya Chen` and `Acme Client Update Draft — Awaiting Approval`. It never calls Mail send. `approve` creates these three tasks, once:

1. Complete Acme security questionnaire
2. Send Acme pricing package
3. Prepare Acme renewal meeting handoff

Each created task carries the direct Handoff Brief URL in its description. The task creation boundary is the manager approval command; the script never changes ownership automatically and never sends the drafted client update.

## Architecture

```text
seed
  └─ Ambiguous REST API (Bearer key)
       ├─ Mail / CRM / Tasks / Calendar / Docs synthetic records
       └─ run.json: returned IDs only

run
  ├─ GET persisted records + bounded CRM/Calendar context
  ├─ one OpenAI Responses API call
  │    └─ strict JSON schema + local semantic validation
  ├─ POST Handoff Brief
  └─ POST unsent client-update draft

approve APPROVE_ACME_HANDOFF
  └─ POST exactly three Tasks, each linking to the Brief
```

## API surface used

The implementation uses the public Ambiguous REST base `https://app.ambiguous.ai`, bearer authentication, and the routes documented in Ambiguous's REST reference:

- `GET /api/mail/:id`, `POST /api/mail/send`
- `GET /api/crm/contacts`, `POST /api/crm/contacts`
- `GET /api/tasks/:id`, `POST /api/tasks`
- `GET /api/calendar/events`, `POST /api/calendar/events`
- `GET /api/documents/:id`, `POST /api/documents`

The public reference shows the same document block shape, calendar `title/start/end/attendees` fields, task `title/assignee/priority/due` fields, and `Authorization: Bearer ...` authentication. If a workspace's enabled API version differs, the failure is printed with the route and response body rather than silently falling back to invented local data.

## Ponytail foundation

This project uses [Dietrich Gebert's Ponytail](https://github.com/DietrichGebert/ponytail) as a development foundation and keeps its core rule: understand the end-to-end flow, then use the smallest safe implementation. It is included as a dev dependency; hosts that support the plugin can also install it with:

```bash
codex plugin marketplace add DietrichGebert/ponytail
codex plugin add ponytail@ponytail
```

The resulting code deliberately uses native `fetch`, native file I/O, one entry file, one model call, manual trust-boundary validation, and no HTTP or schema dependency.

## Security and limitations

- `.env`, Ambiguous CLI credentials, `node_modules`, and build output are ignored.
- Only synthetic `example.com` / `acme.example` identities appear in the seed.
- The demo does not send to a real Acme address; `run` never sends mail at all.
- The direct UI URL patterns are based on Ambiguous's documented resource paths (`/docs/:id`, `/tasks/:id`, `/mail/:id`, `/crm/contacts/:id`, `/calendar/events/:id`). Confirm them in the workspace UI during the demo.
- Live end-to-end execution requires valid Ambiguous and OpenAI credentials plus the corresponding API permissions. This environment has no credentials, so external API behavior cannot be exercised here.
