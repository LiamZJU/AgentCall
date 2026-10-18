export function log(message: string, extra?: unknown): void {
  const tail = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  console.error(`[agentphone] ${message}${tail}`);
}
