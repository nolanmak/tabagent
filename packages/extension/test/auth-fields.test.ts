// #33 login-form detection table, #34 code-destination table.
import { describe, expect, it } from "vitest";
import { detectCodeField, detectLogin, detectSignup, isOneTimeCodeAutocomplete, type FieldDesc } from "../src/background/auth/pure/fields";

let n = 0;
export function f(o: Partial<FieldDesc>): FieldDesc {
  return { i: n++, tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", visible: true, form: 0, maxLength: -1, inputMode: "", ...o };
}
const list = (...xs: Partial<FieldDesc>[]) => {
  n = 0;
  return xs.map(f);
};

describe("detectLogin", () => {
  const rows: [string, FieldDesc[], ReturnType<typeof detectLogin>][] = [
    ["classic form", list({ type: "email", name: "email", label: "Email" }, { type: "password", name: "password" }), { ok: true, kind: "classic", username: 0, password: 1, form: 0 }],
    [
      "nearest preceding text field wins over an earlier one",
      list({ name: "search", label: "Search", form: -1 }, { name: "login", label: "Login" }, { type: "password" }),
      { ok: true, kind: "classic", username: 1, password: 2, form: 0 },
    ],
    ["autocomplete=username preferred", list({ name: "u", autocomplete: "username" }, { name: "company" }, { type: "password" }), { ok: true, kind: "classic", username: 0, password: 2, form: 0 }],
    ["username-first step", list({ type: "email", name: "identifier", label: "Email or phone" }), { ok: true, kind: "username-only", username: 0, form: 0 }],
    ["username-first step by autocomplete", list({ name: "x", autocomplete: "username webauthn" }), { ok: true, kind: "username-only", username: 0, form: 0 }],
    ["password-only step", list({ type: "hidden" as any, visible: false }, { type: "password", name: "Passwd" }), { ok: true, kind: "password-only", password: 1, form: 0 }],
    ["hidden password field ignored → username step", list({ type: "email", name: "email" }, { type: "password", visible: false }), { ok: true, kind: "username-only", username: 0, form: 0 }],
    ["username in another form is not paired", list({ name: "user", form: 1 }, { type: "password", form: 0 }), { ok: true, kind: "password-only", password: 1, form: 0 }],
  ];
  for (const [name, fields, want] of rows) it(name, () => expect(detectLogin(fields)).toEqual(want));

  it("signup form with two password fields is not a login", () => {
    const r = detectLogin(list({ type: "email", name: "email" }, { type: "password", name: "password" }, { type: "password", name: "confirm" }));
    expect(r).toMatchObject({ ok: false, signup: true });
  });
  it("new-password is not a login", () => {
    expect(detectLogin(list({ name: "username" }, { type: "password", autocomplete: "new-password" }))).toMatchObject({ ok: false, signup: true });
  });
  it("login form next to a signup form is still found", () => {
    const r = detectLogin(list({ name: "email", form: 0 }, { type: "password", form: 0 }, { type: "password", form: 0 }, { name: "user", form: 1 }, { type: "password", form: 1 }));
    expect(r).toEqual({ ok: true, kind: "classic", username: 3, password: 4, form: 1 });
  });
  it("no fields → no login form", () => expect(detectLogin([])).toMatchObject({ ok: false }));
  it("a newsletter email box is not a username step", () => expect(detectLogin(list({ type: "email", name: "newsletter", label: "Subscribe" }))).toMatchObject({ ok: false }));
  it("disabled and readonly fields are ignored", () => expect(detectLogin(list({ name: "user", disabled: true }, { type: "password", readOnly: true }))).toMatchObject({ ok: false }));
  it("one-time-code field is never a username", () => expect(detectLogin(list({ name: "otp", autocomplete: "one-time-code", label: "Login code" }))).toMatchObject({ ok: false }));
});

describe("detectSignup (#112)", () => {
  const rows: [string, FieldDesc[], ReturnType<typeof detectSignup>][] = [
    ["email + password + confirm", list({ type: "email", name: "email" }, { type: "password", name: "password" }, { type: "password", name: "confirm" }), { ok: true, email: 0, passwords: [1, 2], form: 0 }],
    ["new-password only", list({ type: "text", name: "email", label: "Email address" }, { type: "password", autocomplete: "new-password" }), { ok: true, email: 0, passwords: [1], form: 0 }],
    [
      "username + email + new-password",
      list({ name: "user_login", autocomplete: "username" }, { type: "email", name: "email" }, { type: "password", autocomplete: "new-password" }),
      { ok: true, username: 0, email: 1, passwords: [2], form: 0 },
    ],
    ["username only", list({ name: "handle", label: "Username" }, { type: "password", autocomplete: "new-password" }), { ok: true, username: 0, passwords: [1], form: 0 }],
    [
      "ignores name fields and the search box outside the form",
      list({ name: "q", label: "Search", form: -1 }, { name: "first_name", label: "First name" }, { type: "email", name: "email" }, { type: "password", autocomplete: "new-password" }, { type: "password", autocomplete: "new-password" }),
      { ok: true, email: 2, passwords: [3, 4], form: 0 },
    ],
  ];
  for (const [name, fields, want] of rows) it(name, () => expect(detectSignup(fields)).toEqual(want));

  it("a login form is not a sign-up form", () => expect(detectSignup(list({ type: "email" }, { type: "password", autocomplete: "current-password" }))).toMatchObject({ ok: false }));
  it("a change-password form is not a sign-up form", () =>
    expect(detectSignup(list({ type: "password", autocomplete: "current-password" }, { type: "password", autocomplete: "new-password" }, { type: "password", autocomplete: "new-password" }))).toMatchObject({ ok: false }));
  it("three unmarked password fields are ambiguous", () => expect(detectSignup(list({ type: "email" }, { type: "password" }, { type: "password" }, { type: "password" }))).toMatchObject({ ok: false }));
  it("no email or username field → not fillable", () => expect(detectSignup(list({ type: "password", autocomplete: "new-password" }, { type: "password", autocomplete: "new-password" }))).toMatchObject({ ok: false }));
});

describe("detectCodeField", () => {
  it("single autocomplete=one-time-code field", () => expect(detectCodeField(list({ name: "x" }, { autocomplete: "one-time-code" }))).toEqual({ ok: true, split: false, field: 1 }));
  it("labelled short numeric field", () => expect(detectCodeField(list({ label: "Verification code", inputMode: "numeric", maxLength: 6 }))).toEqual({ ok: true, split: false, field: 0 }));
  it("labelled field without maxLength", () => expect(detectCodeField(list({ name: "otp" }))).toEqual({ ok: true, split: false, field: 0 }));
  it("six split one-digit inputs, in order", () => {
    const fs = list(...Array.from({ length: 6 }, (_, k) => ({ maxLength: 1, inputMode: "numeric", label: `Digit ${k + 1}` })));
    expect(detectCodeField(fs)).toEqual({ ok: true, split: true, fields: [0, 1, 2, 3, 4, 5] });
  });
  it("split inputs with one-time-code on the first box", () => {
    const fs = list({ maxLength: 1, autocomplete: "one-time-code" }, ...Array.from({ length: 5 }, () => ({ maxLength: 1 })));
    expect(detectCodeField(fs)).toEqual({ ok: true, split: true, fields: [0, 1, 2, 3, 4, 5] });
  });
  it("split inputs all marked one-time-code", () => {
    const fs = list(...Array.from({ length: 4 }, () => ({ maxLength: 1, autocomplete: "one-time-code" })));
    expect(detectCodeField(fs)).toEqual({ ok: true, split: true, fields: [0, 1, 2, 3] });
  });
  it("two one-time-code fields → ambiguous", () => expect(detectCodeField(list({ autocomplete: "one-time-code" }, { autocomplete: "one-time-code", form: 1 }))).toMatchObject({ ok: false, count: 2 }));
  it("two labelled code fields → ambiguous", () => expect(detectCodeField(list({ label: "SMS code" }, { label: "Backup code" }))).toMatchObject({ ok: false, count: 2 }));
  it("no code field → error", () => expect(detectCodeField(list({ name: "email", type: "email" }, { type: "password" }))).toMatchObject({ ok: false, count: 0 }));
  it("hidden code field is ignored", () => expect(detectCodeField(list({ autocomplete: "one-time-code", visible: false }))).toMatchObject({ ok: false }));
  it("a password field is never a labelled code destination", () => expect(detectCodeField(list({ type: "password", label: "PIN code" }))).toMatchObject({ ok: false }));
  it("username field is not a code field even with 'login' in its label", () => expect(detectCodeField(list({ name: "username", label: "Login code or username" }))).toMatchObject({ ok: false }));
});

describe("isOneTimeCodeAutocomplete", () => {
  it.each([
    ["one-time-code", true],
    ["section-x one-time-code", true],
    ["ONE-TIME-CODE", true],
    ["off", false],
    ["", false],
    [null, false],
  ])("%s → %s", (v, want) => expect(isOneTimeCodeAutocomplete(v as any)).toBe(want));
});
