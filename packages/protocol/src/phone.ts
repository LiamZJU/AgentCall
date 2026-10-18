const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeE164(input: string): string {
  const digits = input.trim().replace(/\D/g, "");
  const withCountry = digits.length === 10 ? `1${digits}` : digits;
  const withPlus = `+${withCountry}`;
  if (!E164.test(withPlus)) {
    throw new Error(`Invalid E.164 phone number: ${input}`);
  }
  return withPlus;
}

export function isUsE164(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164);
}
