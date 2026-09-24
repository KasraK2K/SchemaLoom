const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` are ops-tunable strings (`15m`, `30d`) that
 * `@nestjs/jwt` understands natively. Cookie `Max-Age` does not, and a cookie whose
 * lifetime drifts from its token's is either a dead session or a zombie one.
 *
 * @throws RangeError on anything that is not `<positive integer><s|m|h|d>`.
 */
export function parseDurationSec(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  const unit = match?.[2];
  const amount = match?.[1];
  if (!unit || !amount) {
    throw new RangeError(`Expected a duration like "15m" or "30d", got "${value}"`);
  }
  const seconds = Number(amount) * (UNIT_SECONDS[unit] ?? 0);
  if (seconds <= 0) throw new RangeError(`Duration must be positive, got "${value}"`);
  return seconds;
}
