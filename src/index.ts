import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = "https://app.ambiguous.ai";
const RUN_PATH = resolve("run.json");
const MAYA_EMAIL = "maya.chen@example.com";
const ACME_CONTACT_EMAIL = "jordan.lee@acme.example";
const APPROVAL_PHRASE = "APPROVE_ACME_HANDOFF";

type JsonObject = Record<string, unknown>;
type MaybeEnvelope = JsonObject | JsonObject[];

type PlanRisk = {
  risk_type: "security_due" | "pricing_unassigned" | "renewal_missing_incoming_am";
  why_it_matters: string;
  deadline: string | null;
  recommended_owner: string;
  next_action: string;
  evidence_id: string;
};

type HandoffPlan = {
  summary: string;
  risks: [PlanRisk, PlanRisk, PlanRisk];
  draft_client_update: string;
};

type RunState = {
  version: 1;
  scenario: { departingManager: string; client: string };
  seed: JsonObject | null;
  plan: HandoffPlan | null;
  artifacts: { brief: JsonObject; clientUpdateDraft: JsonObject } | null;
  approval: { status: "in_progress" | "approved"; taskIds: string[] } | null;
};

function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Environment variables may be supplied by the shell instead.
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and add it.`);
  return value;
}

function apiKey(): string {
  return requiredEnv("AMBIGUOUS_API_KEY");
}

async function ambiguous<T = JsonObject>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey()}`);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`Ambiguous ${init.method ?? "GET"} ${path} -> ${response.status}: ${String(text).slice(0, 500)}`);
  }
  return body as T;
}

function post<T = JsonObject>(path: string, body: JsonObject): Promise<T> {
  return ambiguous<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function get<T = JsonObject>(path: string): Promise<T> {
  return ambiguous<T>(path);
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function firstId(value: unknown): string {
  const object = asObject(value);
  const direct = object.id;
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["document", "doc", "message", "mail", "task", "event", "contact", "deal", "result"]) {
    const nested = asObject(object[key]).id;
    if (typeof nested === "string" && nested) return nested;
  }
  throw new Error(`Ambiguous response did not contain a record id: ${JSON.stringify(value).slice(0, 500)}`);
}

function listItems(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(asObject);
  const object = asObject(value);
  for (const key of ["items", "results", "data", "messages", "tasks", "events", "contacts"]) {
    if (Array.isArray(object[key])) return object[key].map(asObject);
  }
  return [];
}

function recordUrl(kind: string, id: string): string {
  const paths: Record<string, string> = {
    mail: "mail",
    task: "tasks",
    document: "docs",
    contact: "crm/contacts",
    event: "calendar/events",
  };
  return `${BASE_URL}/${paths[kind] ?? kind}/${id}`;
}

function readState(): RunState {
  return JSON.parse(readFileSync(RUN_PATH, "utf8")) as RunState;
}

function saveState(state: RunState): void {
  writeFileSync(RUN_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWeekday(targetDay: number, from = new Date()): Date {
  const date = new Date(from);
  const delta = (targetDay - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  date.setHours(10, 0, 0, 0);
  return date;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

async function seed(): Promise<void> {
  const state = readState();
  if (state.seed) {
    console.log("Seed already exists in run.json; keeping it to avoid duplicate workspace records.");
    printSeed(state.seed);
    return;
  }

  const due = nextWeekday(5);
  const meetingStart = addDays(due, 3);
  meetingStart.setHours(14, 0, 0, 0);
  const meetingEnd = addDays(meetingStart, 0);
  meetingEnd.setMinutes(60);

  const contactResponse = await post("/api/crm/contacts", {
    name: "Jordan Lee",
    company: "Acme Corp",
    email: ACME_CONTACT_EMAIL,
  });
  const contactId = firstId(contactResponse);

  const mailBodies = [
    {
      subject: "Acme renewal: security questionnaire and pricing due Friday",
      body_markdown: `From: Acme Corp <${ACME_CONTACT_EMAIL}>\n\nHi Maya, please send the completed security questionnaire and the renewal pricing package by ${isoDate(due)} (Friday).`,
    },
    {
      subject: "Re: Acme renewal: security questionnaire and pricing due Friday",
      body_markdown: `From: Maya Chen <${MAYA_EMAIL}>\n\nWe will send both the completed security questionnaire and pricing package by Friday, ${isoDate(due)}.`,
    },
    {
      subject: "Acme renewal meeting confirmed for next week",
      body_markdown: `From: Acme Corp <${ACME_CONTACT_EMAIL}>\n\nThe renewal meeting is confirmed for next week. Please include the incoming account manager in the meeting.`,
    },
  ];
  const inbox = process.env.AMBIGUOUS_INBOX_ADDRESS ?? "exit-compass@example.com";
  const mailResponses = [];
  for (const message of mailBodies) {
    mailResponses.push(await post("/api/mail/send", { to: [inbox], ...message }));
  }

  const taskResponses = await Promise.all([
    post("/api/tasks", {
      title: "Maya: Follow up on Acme pricing",
      description: `Open Maya Chen task for ${isoDate(due)}. Client: Acme Corp.`,
      priority: "high",
      due: isoDate(due),
      assignee: MAYA_EMAIL,
    }),
    post("/api/tasks", {
      title: "Maya: Coordinate Acme security review",
      description: `Open Maya Chen task for ${isoDate(due)}. Client: Acme Corp.`,
      priority: "high",
      due: isoDate(due),
      assignee: MAYA_EMAIL,
    }),
  ]);

  const eventResponse = await post("/api/calendar/events", {
    title: "Acme Corp renewal meeting",
    start: meetingStart.toISOString(),
    end: meetingEnd.toISOString(),
    attendees: [MAYA_EMAIL, ACME_CONTACT_EMAIL],
    notes: "Renewal meeting. Incoming account manager is not yet included.",
  });

  const deliveryNoteResponse = await post("/api/documents", {
    type: "doc",
    title: "Acme delivery note — technical dependency",
    content: [
      { type: "heading", level: 1, text: "Acme delivery note" },
      { type: "paragraph", text: "Synthetic internal note for the Exit Compass demo." },
      { type: "paragraph", text: "Security review depends on the platform team's SSO configuration checklist before the questionnaire can be marked complete." },
      { type: "paragraph", text: "Current relationship owner: Maya Chen. No successor is recorded." },
    ],
  });

  const seedData: JsonObject = {
    dueDate: isoDate(due),
    renewalMeetingStart: meetingStart.toISOString(),
    contact: { id: contactId, url: recordUrl("contact", contactId) },
    mail: mailResponses.map((response) => {
      const id = firstId(response);
      return { id, url: recordUrl("mail", id) };
    }),
    tasks: taskResponses.map((response) => {
      const id = firstId(response);
      return { id, url: recordUrl("task", id) };
    }),
    calendarEvent: (() => {
      const id = firstId(eventResponse);
      return { id, url: recordUrl("event", id) };
    })(),
    deliveryNote: (() => {
      const id = firstId(deliveryNoteResponse);
      return { id, url: recordUrl("document", id) };
    })(),
  };

  state.seed = seedData;
  saveState(state);
  printSeed(seedData);
  console.log("\nSeed complete. Run `npm run run` to analyze this bounded context.");
}

function printSeed(seed: JsonObject): void {
  console.log("Seeded synthetic Maya Chen / Acme Corp records:");
  for (const [key, value] of Object.entries(seed)) {
    if (key === "mail" || key === "tasks") {
      for (const item of value as JsonObject[]) console.log(`  ${key}: ${String(item.url)}`);
    } else if (asObject(value).url) {
      console.log(`  ${key}: ${String(asObject(value).url)}`);
    }
  }
}

function seedId(seed: JsonObject, key: string): string {
  return String(asObject(seed[key]).id);
}

function seededIds(seed: JsonObject): string[] {
  const ids = [seedId(seed, "contact"), seedId(seed, "calendarEvent"), seedId(seed, "deliveryNote")];
  for (const item of (seed.mail as JsonObject[])) ids.push(String(item.id));
  for (const item of (seed.tasks as JsonObject[])) ids.push(String(item.id));
  return ids.filter(Boolean);
}

async function readBoundedContext(seed: JsonObject): Promise<JsonObject[]> {
  const mail = await Promise.all((seed.mail as JsonObject[]).map(({ id }) => get(`/api/mail/${String(id)}`)));
  const tasks = await Promise.all((seed.tasks as JsonObject[]).map(({ id }) => get(`/api/tasks/${String(id)}`)));
  const [note, contacts, events] = await Promise.all([
    get(`/api/documents/${seedId(seed, "deliveryNote")}`),
    get("/api/crm/contacts?limit=25"),
    get("/api/calendar/events?limit=25"),
  ]);
  const contactId = seedId(seed, "contact");
  const eventId = seedId(seed, "calendarEvent");
  const contact = listItems(contacts).find((item) => item.id === contactId) ?? asObject(contacts);
  const event = listItems(events).find((item) => item.id === eventId) ?? asObject(events);
  return [
    ...mail.map((record, index) => ({
      evidence_id: String((seed.mail as JsonObject[])[index].id),
      kind: "mail",
      url: String((seed.mail as JsonObject[])[index].url),
      record,
    })),
    ...tasks.map((record, index) => ({
      evidence_id: String((seed.tasks as JsonObject[])[index].id),
      kind: "task",
      url: String((seed.tasks as JsonObject[])[index].url),
      record,
    })),
    { evidence_id: contactId, kind: "crm_contact", url: String(asObject(seed.contact).url), record: contact },
    { evidence_id: eventId, kind: "calendar_event", url: String(asObject(seed.calendarEvent).url), record: event },
    { evidence_id: seedId(seed, "deliveryNote"), kind: "document", url: String(asObject(seed.deliveryNote).url), record: note },
  ];
}

function compactContext(records: JsonObject[]): string {
  return records
    .map((record) => JSON.stringify(record, (_key, value) => (typeof value === "string" ? value.slice(0, 1200) : value)))
    .join("\n");
}

const planSchema = (evidenceIds: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks", "draft_client_update"],
  properties: {
    summary: { type: "string" },
    risks: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk_type", "why_it_matters", "deadline", "recommended_owner", "next_action", "evidence_id"],
        properties: {
          risk_type: { type: "string", enum: ["security_due", "pricing_unassigned", "renewal_missing_incoming_am"] },
          why_it_matters: { type: "string" },
          deadline: { anyOf: [{ type: "string" }, { type: "null" }] },
          recommended_owner: { type: "string" },
          next_action: { type: "string" },
          evidence_id: { type: "string", enum: evidenceIds },
        },
      },
    },
    draft_client_update: { type: "string" },
  },
});

async function openAiPlan(records: JsonObject[], dueDate: string): Promise<HandoffPlan> {
  const key = requiredEnv("OPENAI_API_KEY");
  const evidenceIds = records.map((record) => String(record.evidence_id));
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "You are Exit Compass. Analyze only the supplied synthetic workspace evidence. Return exactly the three required risks, prioritizing evidence over assumptions. Never claim to have sent anything. The draft is for manager review only.",
        },
        {
          role: "user",
          content: `Maya Chen leaves Friday. Acme Corp has a renewal meeting next week. The known due date is ${dueDate}. Identify these required risk types exactly once: security_due, pricing_unassigned, renewal_missing_incoming_am. Every risk must cite one supplied evidence_id.\n\nBOUNDED EVIDENCE:\n${compactContext(records)}`,
        },
      ],
      text: { format: { type: "json_schema", name: "exit_compass_handoff", strict: true, schema: planSchema(evidenceIds) } },
    }),
  });
  const body = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`OpenAI POST /v1/responses -> ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  const output = Array.isArray(body.output) ? body.output : [];
  const outputContent = output.flatMap((item) => {
    const content = asObject(item).content;
    return Array.isArray(content) ? content : [];
  });
  const textPart = outputContent.find((item) => typeof asObject(item).text === "string");
  const outputText = typeof body.output_text === "string" ? body.output_text : String(asObject(textPart).text ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error(`OpenAI returned non-JSON structured output: ${outputText.slice(0, 500)}`);
  }
  validatePlan(parsed, evidenceIds);
  return parsed as HandoffPlan;
}

function validatePlan(value: unknown, evidenceIds: string[]): asserts value is HandoffPlan {
  const plan = asObject(value);
  const risks = plan.risks;
  if (typeof plan.summary !== "string" || typeof plan.draft_client_update !== "string" || !Array.isArray(risks) || risks.length !== 3) {
    throw new Error("Structured output validation failed: expected summary, exactly three risks, and draft_client_update.");
  }
  const types = new Set<string>();
  for (const item of risks) {
    const risk = asObject(item);
    if (typeof risk.risk_type !== "string" || types.has(risk.risk_type) || !["security_due", "pricing_unassigned", "renewal_missing_incoming_am"].includes(risk.risk_type)) {
      throw new Error("Structured output validation failed: risk types must be the three required unique values.");
    }
    if (typeof risk.why_it_matters !== "string" || (risk.deadline !== null && typeof risk.deadline !== "string") || typeof risk.recommended_owner !== "string" || typeof risk.next_action !== "string" || typeof risk.evidence_id !== "string" || !evidenceIds.includes(risk.evidence_id)) {
      throw new Error("Structured output validation failed: every risk needs valid fields and seeded evidence.");
    }
    types.add(risk.risk_type);
  }
}

function blocksForBrief(plan: HandoffPlan, records: JsonObject[], dueDate: string): JsonObject[] {
  const byId = new Map(records.map((record) => [String(record.evidence_id), record]));
  return [
    { type: "heading", level: 1, text: "Acme Handoff Brief — Maya Chen" },
    { type: "heading", level: 2, text: "Maya’s departure context" },
    { type: "paragraph", text: `Maya Chen leaves Friday, ${dueDate}. Acme Corp has a renewal meeting next week.` },
    { type: "heading", level: 2, text: "Client status" },
    { type: "paragraph", text: plan.summary },
    { type: "heading", level: 2, text: "Top risks" },
    ...plan.risks.map((risk, index) => ({ type: "paragraph", text: `${index + 1}. ${risk.risk_type}: ${risk.why_it_matters} Deadline: ${risk.deadline ?? "Not confirmed"}. Recommended owner: ${risk.recommended_owner}. Next action: ${risk.next_action}. Evidence: ${String(byId.get(risk.evidence_id)?.url ?? "unknown")}` })),
    { type: "heading", level: 2, text: "Evidence" },
    ...records.map((record) => ({ type: "paragraph", text: `${String(record.kind)} ${String(record.evidence_id)}: ${String(record.url)}` })),
    { type: "heading", level: 2, text: "Recommended owner and next action" },
    ...plan.risks.map((risk) => ({ type: "paragraph", text: `${risk.recommended_owner}: ${risk.next_action}` })),
    { type: "heading", level: 2, text: "Draft client update" },
    { type: "paragraph", text: plan.draft_client_update },
    { type: "heading", level: 2, text: "Approval status" },
    { type: "paragraph", text: `Awaiting manager approval. No external communication has been sent. Approval phrase: ${APPROVAL_PHRASE}.` },
  ];
}

async function run(): Promise<void> {
  const state = readState();
  if (!state.seed) throw new Error("No seed in run.json. Run `npm run seed` first.");
  if (state.artifacts && state.plan) {
    console.log(`Run already complete. Brief: ${String(state.artifacts.brief.url)}`);
    console.log(`Client draft: ${String(state.artifacts.clientUpdateDraft.url)}`);
    return;
  }

  const records = await readBoundedContext(state.seed);
  const plan = await openAiPlan(records, String(state.seed.dueDate));
  state.plan = plan;

  const briefResponse = await post("/api/documents", {
    type: "doc",
    title: "Acme Handoff Brief — Maya Chen",
    content: blocksForBrief(plan, records, String(state.seed.dueDate)),
  });
  const briefId = firstId(briefResponse);
  const briefUrl = recordUrl("document", briefId);
  const draftResponse = await post("/api/documents", {
    type: "doc",
    title: "Acme Client Update Draft — Awaiting Approval",
    content: [
      { type: "heading", level: 1, text: "Acme Client Update Draft" },
      { type: "paragraph", text: plan.draft_client_update },
      { type: "paragraph", text: `Status: Draft only. Awaiting manager approval. No external communication has been sent. Handoff Brief: ${briefUrl}` },
    ],
  });
  const draftId = firstId(draftResponse);

  state.artifacts = {
    brief: { id: briefId, url: briefUrl },
    clientUpdateDraft: { id: draftId, url: recordUrl("document", draftId) },
  };
  saveState(state);
  console.log("\nExit Compass found exactly three evidence-backed risks:");
  for (const risk of plan.risks) console.log(`  - ${risk.risk_type}: ${risk.next_action} [${risk.evidence_id}]`);
  console.log(`\nHandoff Brief: ${briefUrl}`);
  console.log(`Unsent client-update draft: ${recordUrl("document", draftId)}`);
  console.log(`\nApproval boundary: no client email was sent and no tasks were created.`);
  console.log(`Run: npm run approve`);
}

async function approve(phrase: string): Promise<void> {
  if (phrase !== APPROVAL_PHRASE) throw new Error(`Approval blocked. Use exactly: ${APPROVAL_PHRASE}`);
  const state = readState();
  if (!state.seed || !state.plan || !state.artifacts) throw new Error("Run `npm run run` before approval.");
  const briefUrl = String(state.artifacts.brief.url);
  const titles = [
    "Complete Acme security questionnaire",
    "Send Acme pricing package",
    "Prepare Acme renewal meeting handoff",
  ];
  const taskIds = [...(state.approval?.taskIds ?? [])];
  state.approval = { status: "in_progress", taskIds };
  saveState(state);
  for (let index = taskIds.length; index < titles.length; index += 1) {
    const task = await post("/api/tasks", {
      title: titles[index],
      description: `Manager-approved Acme handoff action. Recommended owner: incoming account manager or manager delegate. Handoff Brief: ${briefUrl}`,
      priority: "high",
      due: String(state.seed.dueDate),
    });
    taskIds.push(firstId(task));
    state.approval = { status: "in_progress", taskIds };
    saveState(state);
  }
  state.approval = { status: "approved", taskIds };
  saveState(state);
  console.log("Approval accepted. Exactly three handoff tasks exist and each description links to the Handoff Brief:");
  for (const [index, id] of taskIds.entries()) console.log(`  ${index + 1}. ${titles[index]}: ${recordUrl("task", id)}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command, argument] = process.argv.slice(2);
  if (command === "seed") return seed();
  if (command === "run") return run();
  if (command === "approve") return approve(argument ?? "");
  throw new Error("Usage: npm run seed | npm run run | npm run approve");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
