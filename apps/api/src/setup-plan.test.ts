import assert from "node:assert/strict";
import test from "node:test";
import { planSetup, type SetupFacts } from "./setup-plan.js";

const base: SetupFacts = {
  twilioSid: "",
  twilioToken: "",
  publicUrl: "",
  name: "",
  adapter: "",
  hermesWsUrl: "",
  proposedNumber: "",
  proposedLocality: "",
  approvedNumber: "",
  boundNumber: "",
  policyApproved: false,
};

test("setup asks the user for Twilio credentials first", () => {
  const plan = planSetup(base);
  assert.equal(plan.status, "need_twilio");
  assert.equal(plan.needsUser, true);
  assert.match(plan.ask, /Auth Token/);
});

test("setup tells the agent to open a tunnel before asking the user", () => {
  const plan = planSetup({ ...base, twilioSid: "ACxxx", twilioToken: "secret", publicUrl: "http://127.0.0.1:8787" });
  assert.equal(plan.status, "need_public_url");
  assert.equal(plan.needsUser, false);
});

test("setup asks the user to approve one exact phone number", () => {
  const plan = planSetup({
    ...base,
    twilioSid: "ACxxx",
    twilioToken: "secret",
    publicUrl: "https://phone.example.com",
    name: "Desk",
    adapter: "generic",
    proposedNumber: "+14155550100",
    proposedLocality: "San Francisco",
  });
  assert.equal(plan.status, "need_number_approval");
  assert.equal(plan.needsUser, true);
  assert.match(plan.ask, /\+14155550100/);
  assert.match(plan.rerun, /--approve-number \+14155550100/);
});

test("setup is ready only after the number is bound and the policy is approved", () => {
  const facts: SetupFacts = {
    ...base,
    twilioSid: "ACxxx",
    twilioToken: "secret",
    publicUrl: "https://phone.example.com",
    name: "Desk",
    adapter: "hermes",
    hermesWsUrl: "ws://127.0.0.1:9119/api/ws",
    boundNumber: "+14155550100",
  };
  assert.equal(planSetup(facts).status, "need_policy_approval");
  assert.equal(planSetup({ ...facts, policyApproved: true }).status, "ready");
});
