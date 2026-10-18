import { randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

export function createToken(): string {
  return randomBytes(24).toString("base64url");
}
