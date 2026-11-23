import { describe, expect, it } from "vitest";
import { clickSensitivity, fieldSensitivity, formSensitivity, isSensitiveField, keySensitivity, MASK, maskValue, submitConfirmation, submitSensitivity } from "../src/pure/sensitive";

describe("sensitive fields (D18a)", () => {
  const pos: [string, Parameters<typeof fieldSensitivity>[0]][] = [
    ["type=password", { type: "password" }],
    ["autocomplete cc-number", { type: "text", autocomplete: "cc-number" }],
    ["autocomplete cc-csc", { type: "text", autocomplete: "billing cc-csc" }],
    ["autocomplete current-password", { type: "text", autocomplete: "current-password" }],
    ["autocomplete new-password", { type: "text", autocomplete: "new-password" }],
    ["label Card number", { type: "text", label: "Card number" }],
    ["name cardnumber", { type: "text", name: "cardnumber" }],
    ["label CVC", { type: "text", label: "CVC" }],
    ["label CVV", { type: "text", label: "Security code (CVV)" }],
    ["name ssn", { type: "text", name: "ssn" }],
    ["label Social Security Number", { type: "text", label: "Social security number" }],
  ];
  for (const [name, d] of pos) it(`positive: ${name}`, () => expect(fieldSensitivity(d)).not.toBeNull());

  const neg: [string, Parameters<typeof fieldSensitivity>[0]][] = [
    ["search box", { type: "search", label: "Search", name: "q" }],
    ["newsletter email", { type: "email", label: "Email for our newsletter", autocomplete: "email" }],
    ["name", { type: "text", label: "Full name", autocomplete: "name" }],
    ["discount code", { type: "text", label: "Discount code" }],
    ["passport-free text", { type: "text", label: "Postcode" }],
    ["cardigan size", { type: "text", label: "Cardigan size" }],
  ];
  for (const [name, d] of neg) it(`negative: ${name}`, () => expect(fieldSensitivity(d)).toBeNull());

  it("form reasons dedupe and list categories", () => {
    const r = formSensitivity([{ type: "password" }, { type: "password", label: "Confirm" }, { type: "text", label: "Card number" }]);
    expect(r).toEqual(["password field", "payment card field"]);
    expect(formSensitivity([{ type: "search" }])).toEqual([]);
  });
});

describe("click keywords (D18b)", () => {
  const pos = ["Buy now", "Purchase", "Pay", "Pay $10", "Place order", "Place Order", "Checkout", "Check out", "Delete", "Delete account", "Remove account", "Send", "Send feedback", "Resend code", "Transfer funds", "Wire money", "Confirm payment"];
  for (const n of pos) it(`positive button: ${n}`, () => expect(clickSensitivity({ role: "button", name: n }).length).toBeGreaterThan(0));
  it("links can be positive", () => expect(clickSensitivity({ role: "link", name: "Delete" }).length).toBe(1));
  const neg: [string, string][] = [
    ["button", "Search"],
    ["textbox", "Sender name"],
    ["button", "Sender name"],
    ["link", "Payment history"],
    ["button", "Paypal login"],
    ["button", "Repay later? No: Display"],
    ["button", "Remove filter"],
    ["button", "Buyer guide"],
    ["button", "Transferable skills"],
    ["button", "Wireless"],
    ["button", "Checkbox"],
    ["button", "Save"],
  ];
  for (const [role, n] of neg) it(`negative ${role}: ${n}`, () => expect(clickSensitivity({ role, name: n })).toEqual([]));
});

describe("submit paths", () => {
  const login = [{ type: "text", label: "Username" }, { type: "password", label: "Password" }];
  it("click on the submit control of a sensitive form", () => {
    expect(submitSensitivity({ role: "button", name: "Sign in", isSubmit: true, formFields: login })).toEqual([{ category: "a", reason: "submits a form with a password field" }]);
  });
  it("click on a non-submit button in a sensitive form is not (a)", () => {
    expect(submitSensitivity({ role: "button", name: "Show password", isSubmit: false, formFields: login })).toEqual([]);
  });
  it("keyword click without a form is (b)", () => {
    expect(submitSensitivity({ role: "button", name: "Delete account", isSubmit: false })).toEqual([{ category: "b", reason: '"Delete account" matches a purchase/delete/send/transfer action' }]);
  });
  it("Enter inside a sensitive form", () => {
    expect(keySensitivity("Enter", { inForm: true, formFields: login })).toEqual([{ category: "a", reason: "Enter submits a form with a password field" }]);
    expect(keySensitivity("Tab", { inForm: true, formFields: login })).toEqual([]);
    expect(keySensitivity("Enter", { inForm: false })).toEqual([]);
    expect(keySensitivity("Enter", { inForm: true, formFields: [{ type: "search" }] })).toEqual([]);
    expect(keySensitivity("Enter", { inForm: true, formFields: login, textarea: true })).toEqual([]);
  });
});

describe("masking + confirmation payload", () => {
  it("masks sensitive values only", () => {
    expect(maskValue({ type: "password" }, "hunter2")).toBe(MASK);
    expect(maskValue({ type: "text", label: "Card number" }, "4242")).toBe(MASK);
    expect(maskValue({ type: "text", label: "Name" }, "Neo")).toBe("Neo");
    expect(maskValue({ type: "password" }, "")).toBe("");
    expect(isSensitiveField({ type: "text", autocomplete: "cc-exp" })).toBe(true);
  });
  it("submit confirmation lists field labels with sensitive values masked", () => {
    const c = submitConfirmation({
      control: "Pay now",
      fields: [
        { label: "Name on card", type: "text", value: "Neo" },
        { label: "Card number", type: "text", value: "4242424242424242" },
        { label: "CVC", type: "text", value: "123" },
        { label: "Password", type: "password", value: "x" },
      ],
    });
    expect(c.summary).toBe('submit "Pay now"');
    const joined = c.reasons.join("\n");
    expect(joined).toContain("Name on card: Neo");
    expect(joined).toContain(`Card number: ${MASK}`);
    expect(joined).toContain(`CVC: ${MASK}`);
    expect(joined).not.toContain("4242");
    expect(joined).not.toContain("123");
  });
});
