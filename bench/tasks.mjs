// Benchmark task set (#24). 20 scripted-goal tasks on the fixture site in
// bench/fixtures, each with a programmatic end-state checker.
//
// A recorded end state is plain data:
//   { url, title, text, bench, answer }
//   url/title/text  - the last session tab on the fixture origin
//   bench           - localStorage["bench"] written by the fixture pages
//   answer          - the agent's final message (for lookup tasks)
// Checkers are pure: (state) => { pass: boolean, reason: string }.
//
// Bump TASK_SET_VERSION whenever a task, fixture or checker changes, so result
// rows from different task sets are never compared.

export const TASK_SET_VERSION = "1.0.0";

const ok = (reason = "ok") => ({ pass: true, reason });
const fail = (reason) => ({ pass: false, reason });
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Every condition must hold; the first failing one is the reason. */
function all(...conds) {
  for (const [cond, reason] of conds) if (!cond) return fail(reason);
  return ok();
}

const answerHas = (state, re) => re.test(String(state.answer ?? ""));
const b = (state) => state.bench ?? {};

export const TASKS = [
  {
    id: "signup-basic",
    page: "signup.html",
    goal: "Sign up for the newsletter as Ada Lovelace with email ada@example.com, accepting the terms.",
    script: [["form.fill", { "Full name": "Ada Lovelace", Email: "ada@example.com", "I accept the terms": true }], ["act.click", { ref: "e5" }]],
    check: (s) => {
      const d = b(s).signup;
      return all([d, "form was not submitted"], [d?.name === "Ada Lovelace", `name is ${d?.name}`], [norm(d?.email) === "ada@example.com", `email is ${d?.email}`], [d?.terms === true, "terms not accepted"]);
    },
  },
  {
    id: "signup-newsletter-opt-in",
    page: "signup.html",
    goal: "Sign up as Grace Hopper (grace@example.com), opt in to the weekly newsletter and accept the terms.",
    script: [["form.fill", { "Full name": "Grace Hopper", Email: "grace@example.com", "Send me the weekly newsletter": true, "I accept the terms": true }], ["act.click", { ref: "e5" }]],
    check: (s) => {
      const d = b(s).signup;
      return all([d, "form was not submitted"], [d?.name === "Grace Hopper", `name is ${d?.name}`], [d?.newsletter === true, "newsletter not checked"], [d?.terms === true, "terms not accepted"]);
    },
  },
  {
    id: "shipping-country",
    page: "shipping.html",
    goal: "Set the shipping country to Canada and save.",
    script: [["act.select", { ref: "e1", value: "Canada" }], ["act.click", { ref: "e4" }]],
    check: (s) => all([b(s).shipping, "shipping not saved"], [b(s).shipping?.country === "ca", `country is ${b(s).shipping?.country}`]),
  },
  {
    id: "shipping-express",
    page: "shipping.html",
    goal: "Ship to France with Express speed and save the shipping details.",
    script: [["form.fill", { Country: "France", Express: true }], ["act.click", { ref: "e4" }]],
    check: (s) => {
      const d = b(s).shipping;
      return all([d, "shipping not saved"], [d?.country === "fr", `country is ${d?.country}`], [d?.speed === "express", `speed is ${d?.speed}`]);
    },
  },
  {
    id: "table-most-expensive",
    page: "products.html",
    goal: "Which product is the most expensive? Answer with just its name.",
    script: [["extract.table", {}]],
    check: (s) => all([answerHas(s, /\bgadget\b/i), `answer was ${JSON.stringify(s.answer)}`], [!answerHas(s, /\b(widget|sprocket|gizmo|doohickey)\b/i), "answer names other products"]),
  },
  {
    id: "table-total-qty",
    page: "products.html",
    goal: "What is the total quantity across all products? Answer with just the number.",
    script: [["extract.table", {}]],
    check: (s) => all([answerHas(s, /(^|\D)42(\D|$)/), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "table-sort-price-desc",
    page: "products.html",
    goal: "Sort the product table by price, most expensive first.",
    script: [["page.snapshot", {}], ["act.click", { ref: "e2" }], ["act.click", { ref: "e2" }]],
    check: (s) => all([b(s).sort === "price-desc", `sort is ${b(s).sort}`], [b(s).firstRow === "Gadget", `first row is ${b(s).firstRow}`]),
  },
  {
    id: "paginate-open-item",
    page: "list.html",
    goal: "Find the catalog item named Sigma (it is not on the first page) and open its details page.",
    script: [["page.snapshot", {}], ["act.click", { ref: "e11" }], ["page.snapshot", {}], ["act.click", { ref: "e30" }]],
    check: (s) => all([b(s).opened === "Sigma", `opened ${b(s).opened}`], [/item=Sigma/.test(s.url ?? ""), `url is ${s.url}`]),
  },
  {
    id: "paginate-count",
    page: "list.html",
    goal: "How many items are in the catalog in total, across all pages? Answer with just the number.",
    script: [["extract.paginate", { extractor: "links", maxPages: 5 }]],
    check: (s) => all([answerHas(s, /(^|\D)23(\D|$)/), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "modal-dismiss-continue",
    page: "modal.html",
    goal: "Get past the cookie banner and press Continue.",
    script: [["page.snapshot", {}], ["act.click", { ref: "e5" }], ["act.click", { ref: "e4" }]],
    check: (s) => all([b(s).cookiesAccepted === true, "cookie banner still up"], [b(s).continued === true, "Continue was not pressed after the banner"]),
  },
  {
    id: "modal-confirm-delete",
    page: "modal.html",
    goal: "Delete the saved item Beta (confirm the deletion). Leave the other items alone.",
    script: [["act.click", { ref: "e5" }], ["act.click", { ref: "e2" }], ["act.click", { ref: "e7" }]],
    check: (s) => {
      const items = b(s).items ?? [];
      return all([!items.includes("Beta"), "Beta is still saved"], [items.includes("Alpha") && items.includes("Gamma"), `other items changed: ${items.join(",")}`]);
    },
  },
  {
    id: "dialog-confirm",
    page: "dialogs.html",
    goal: "Archive the account (accept the confirmation).",
    script: [["act.click", { ref: "e1" }], ["dialog.handle", { action: "accept" }]],
    check: (s) => all([b(s).archived === true, `archived is ${b(s).archived}`]),
  },
  {
    id: "dialog-prompt",
    page: "dialogs.html",
    goal: "Set the display name to Grace.",
    script: [["act.click", { ref: "e2" }], ["dialog.handle", { action: "accept", promptText: "Grace" }]],
    check: (s) => all([b(s).displayName === "Grace", `displayName is ${JSON.stringify(b(s).displayName)}`]),
  },
  {
    id: "frame-form",
    page: "frame.html",
    goal: "Send the support message 'My order is late' using the embedded form.",
    script: [["page.snapshot", {}], ["act.type", { ref: "e1", text: "My order is late" }], ["act.click", { ref: "e2" }]],
    check: (s) => all([b(s).support, "support form not sent"], [norm(b(s).support?.message) === "my order is late", `message is ${b(s).support?.message}`]),
  },
  {
    id: "shadow-dom-toggle",
    page: "shadow.html",
    goal: "Turn on dark mode and save the preferences.",
    script: [["page.snapshot", {}], ["act.click", { ref: "e1" }], ["act.click", { ref: "e2" }]],
    check: (s) => all([b(s).prefs, "preferences not saved"], [b(s).prefs?.dark === true, "dark mode is off"]),
  },
  {
    id: "popup-tracking-code",
    page: "popup.html",
    goal: "What is the tracking code shown on the carrier page? Answer with just the code.",
    script: [["act.click", { ref: "e1" }], ["tabs", { action: "list" }], ["page.markdown", {}]],
    check: (s) => all([answerHas(s, /HX-4271/i), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "delayed-results",
    page: "delayed.html",
    goal: "Search for flights from SFO and tell me how many were found. Answer with just the number.",
    script: [["act.type", { ref: "e1", text: "SFO" }], ["act.click", { ref: "e2" }], ["nav.wait", { for: "text", value: "flights found" }], ["page.markdown", {}]],
    check: (s) => all([norm(b(s).searched) === "sfo", `searched for ${b(s).searched}`], [answerHas(s, /(^|\D)17(\D|$)/), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "download-row-count",
    page: "report.html",
    profile: "core,data",
    goal: "Download the monthly report CSV and tell me which region had the highest revenue.",
    script: [["act.click", { ref: "e1" }], ["downloads.wait", {}], ["downloads.read", { id: 1 }]],
    check: (s) => all([b(s).downloaded === true, "report was not downloaded"], [answerHas(s, /\beast\b/i), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "link-url",
    page: "links.html",
    goal: "What path does the Pricing link in the main navigation point to? Answer with just the path.",
    script: [["page.snapshot", {}]],
    check: (s) => all([answerHas(s, /\/plans-and-pricing-2026/), `answer was ${JSON.stringify(s.answer)}`]),
  },
  {
    id: "checkout-multi-step",
    page: "shop.html",
    goal: "Buy 2 Widgets: add them to the cart, open the cart, and place the order to 1 Main St, Paris.",
    script: [["act.type", { ref: "e1", text: "2" }], ["act.click", { ref: "e2" }], ["act.click", { ref: "e5" }], ["form.fill", { Street: "1 Main St", City: "Paris" }], ["act.click", { ref: "e3" }]],
    check: (s) => {
      const o = b(s).order;
      const qty = (o?.lines ?? []).filter((l) => l.item === "Widget").reduce((n, l) => n + l.qty, 0);
      const others = (o?.lines ?? []).filter((l) => l.item !== "Widget").length;
      return all([o, "order not placed"], [qty === 2, `widget quantity is ${qty}`], [others === 0, "cart has other items"], [norm(o?.city) === "paris", `city is ${o?.city}`], [norm(o?.street) === "1 main st", `street is ${o?.street}`]);
    },
  },
];

/** Profile a task runs with: `core` unless it states otherwise (#24). */
export const profileOf = (task) => task.profile ?? "core";

export function getTask(id) {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}; known: ${TASKS.map((x) => x.id).join(", ")}`);
  return t;
}
