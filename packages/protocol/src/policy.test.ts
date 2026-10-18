import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAction, type Policy } from "./policy.js";

const quotePolicy: Policy = {
  objective: "Get a quote for 50 units. Do not purchase.",
  allowedActions: ["ask_price", "commit_price", "schedule_callback"],
  forbiddenActions: ["purchase", "share_payment_details", "agree_contract"],
  approvalRules: [{ action: "commit_price", when: { amountUsdGt: 100 } }],
};

test("forbidden purchase is denied", () => {
  const result = evaluateAction(quotePolicy, "purchase", { amountUsd: 10 });
  assert.equal(result.decision, "deny");
});

test("commit above 100 dollars waits for approval", () => {
  const result = evaluateAction(quotePolicy, "commit_price", { amountUsd: 150 });
  assert.equal(result.decision, "approval");
});

test("commit at the threshold is allowed", () => {
  const result = evaluateAction(quotePolicy, "commit_price", { amountUsd: 100 });
  assert.equal(result.decision, "allow");
});

test("a missing amount on a threshold rule fails closed", () => {
  const result = evaluateAction(quotePolicy, "commit_price", {});
  assert.equal(result.decision, "approval");
});

test("actions outside the allow list are denied", () => {
  const result = evaluateAction(quotePolicy, "transfer_call", {});
  assert.equal(result.decision, "deny");
});

test("hangup stays available unless it is forbidden", () => {
  assert.equal(evaluateAction(quotePolicy, "hangup", {}).decision, "allow");
  const blocked: Policy = { ...quotePolicy, forbiddenActions: ["hangup"] };
  assert.equal(evaluateAction(blocked, "hangup", {}).decision, "deny");
});

test("an empty allow list permits non-forbidden actions", () => {
  const open: Policy = {
    objective: "",
    allowedActions: [],
    forbiddenActions: ["purchase"],
    approvalRules: [],
  };
  assert.equal(evaluateAction(open, "ask_price", {}).decision, "allow");
  assert.equal(evaluateAction(open, "purchase", {}).decision, "deny");
});

test("always rules require approval", () => {
  const policy: Policy = {
    objective: "",
    allowedActions: ["purchase"],
    forbiddenActions: [],
    approvalRules: [{ action: "purchase", when: "always" }],
  };
  assert.equal(evaluateAction(policy, "purchase", {}).decision, "approval");
});
