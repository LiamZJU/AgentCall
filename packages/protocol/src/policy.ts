export type ApprovalWhen = "always" | { amountUsdGt: number };

export type ApprovalRule = {
  action: string;
  when: ApprovalWhen;
};

export type Policy = {
  objective: string;
  allowedActions: string[];
  forbiddenActions: string[];
  approvalRules: ApprovalRule[];
};

export type ActionDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "approval"; reason: string };

const BUILTIN_ACTIONS = new Set(["hangup", "schedule_callback", "thread_update"]);

export const EMPTY_POLICY: Policy = {
  objective: "",
  allowedActions: [],
  forbiddenActions: [],
  approvalRules: [],
};

export function evaluateAction(
  policy: Policy,
  action: string,
  payload: Record<string, unknown>,
): ActionDecision {
  if (policy.forbiddenActions.includes(action)) {
    return { decision: "deny", reason: `Action ${action} is forbidden by this call` };
  }

  const rule = policy.approvalRules.find(
    (candidate) => candidate.action === action && ruleMatches(candidate.when, payload),
  );
  if (rule) {
    return {
      decision: "approval",
      reason: `Action ${action} needs a person to confirm it`,
    };
  }

  if (BUILTIN_ACTIONS.has(action)) {
    return { decision: "allow" };
  }

  if (policy.allowedActions.length > 0 && !policy.allowedActions.includes(action)) {
    return { decision: "deny", reason: `Action ${action} is not in the allowed list` };
  }

  return { decision: "allow" };
}

function ruleMatches(when: ApprovalWhen, payload: Record<string, unknown>): boolean {
  if (when === "always") return true;
  const amount = readAmount(payload);
  if (amount === null) return true;
  return amount > when.amountUsdGt;
}

function readAmount(payload: Record<string, unknown>): number | null {
  const raw = payload.amountUsd ?? payload.amount;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return null;
}
