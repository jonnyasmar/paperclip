/**
 * Lightweight cron expression parser and next-run calculator.
 *
 * Supports standard 5-field cron expressions:
 *
 *   ┌────────────── minute (0–59)
 *   │ ┌──────────── hour   (0–23)
 *   │ │ ┌────────── day of month (1–31)
 *   │ │ │ ┌──────── month  (1–12)
 *   │ │ │ │ ┌────── day of week (0–6, Sun=0)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Supported syntax per field:
 *   - `*`        — any value
 *   - `N`        — exact value
 *   - `N-M`      — range (inclusive)
 *   - `N/S`      — start at N, step S (within field bounds)
 *   - `* /S`     — every S (from field min)   [no space — shown to avoid comment termination]
 *   - `N-M/S`    — range with step
 *   - `N,M,...`  — list of values, ranges, or steps
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed cron schedule. Each field is a sorted array of valid integer values
 * for that field.
 */
export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field token (e.g. `"5"`, `"1-3"`, `"* /10"`, `"1,3,5"`).
 *
 * @returns Sorted deduplicated array of matching integer values within bounds.
 * @throws {Error} on invalid syntax or out-of-range values.
 */
function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();

  // Split on commas first — each part can be a value, range, or step
  const parts = token.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error(`Empty element in cron ${spec.name} field`);
    }

    // Check for step syntax: "X/S" where X is "*" or a range or a number
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(
          `Invalid step "${stepStr}" in cron ${spec.name} field`,
        );
      }

      let rangeStart = spec.min;
      let rangeEnd = spec.max;

      if (base === "*") {
        // */S — every S from field min
      } else if (base.includes("-")) {
        // N-M/S — range with step
        const [a, b] = base.split("-").map((s) => parseInt(s, 10));
        if (isNaN(a!) || isNaN(b!)) {
          throw new Error(
            `Invalid range "${base}" in cron ${spec.name} field`,
          );
        }
        rangeStart = a!;
        rangeEnd = b!;
      } else {
        // N/S — start at N, step S
        const start = parseInt(base, 10);
        if (isNaN(start)) {
          throw new Error(
            `Invalid start "${base}" in cron ${spec.name} field`,
          );
        }
        rangeStart = start;
      }

      validateBounds(rangeStart, spec);
      validateBounds(rangeEnd, spec);

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    // Check for range syntax: "N-M"
    if (trimmed.includes("-")) {
      const [aStr, bStr] = trimmed.split("-");
      const a = parseInt(aStr!, 10);
      const b = parseInt(bStr!, 10);
      if (isNaN(a) || isNaN(b)) {
        throw new Error(
          `Invalid range "${trimmed}" in cron ${spec.name} field`,
        );
      }
      validateBounds(a, spec);
      validateBounds(b, spec);
      if (a > b) {
        throw new Error(
          `Invalid range ${a}-${b} in cron ${spec.name} field (start > end)`,
        );
      }
      for (let i = a; i <= b; i++) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let i = spec.min; i <= spec.max; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(trimmed, 10);
    if (isNaN(val)) {
      throw new Error(
        `Invalid value "${trimmed}" in cron ${spec.name} field`,
      );
    }
    validateBounds(val, spec);
    values.add(val);
  }

  if (values.size === 0) {
    throw new Error(`Empty result for cron ${spec.name} field`);
  }

  return [...values].sort((a, b) => a - b);
}

function validateBounds(value: number, spec: FieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a cron expression string into a structured {@link ParsedCron}.
 *
 * @param expression — A standard 5-field cron expression.
 * @returns Parsed cron with sorted valid values for each field.
 * @throws {Error} on invalid syntax.
 *
 * @example
 * ```ts
 * const parsed = parseCron("0 * * * *"); // every hour at minute 0
 * // parsed.minutes === [0]
 * // parsed.hours === [0,1,2,...,23]
 * ```
 */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression must not be empty");
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`,
    );
  }

  return {
    minutes: parseField(tokens[0]!, FIELD_SPECS[0]!),
    hours: parseField(tokens[1]!, FIELD_SPECS[1]!),
    daysOfMonth: parseField(tokens[2]!, FIELD_SPECS[2]!),
    months: parseField(tokens[3]!, FIELD_SPECS[3]!),
    daysOfWeek: parseField(tokens[4]!, FIELD_SPECS[4]!),
  };
}

/**
 * Validate a cron expression string. Returns `null` if valid, or an error
 * message string if invalid.
 *
 * @param expression — A cron expression string to validate.
 * @returns `null` on success, error message on failure.
 */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Calculate the next run time after `after` for the given parsed cron schedule.
 *
 * Starts from the minute immediately following `after` and walks forward
 * until a matching minute is found (up to a safety limit of ~4 years to
 * prevent infinite loops on impossible schedules).
 *
 * @param cron  — Parsed cron schedule.
 * @param after — The reference date. The returned date will be strictly after this.
 * @returns The next matching `Date`, or `null` if no match found within the search window.
 */
export function nextCronTick(cron: ParsedCron, after: Date, timezone?: string): Date | null {
  const d = new Date(after.getTime());

  // When an explicit IANA timezone is given, use Intl-based resolution.
  // Otherwise evaluate against the machine's local time (Date local methods).
  const useIntlTz = !!timezone;

  // Advance to the next whole minute
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Safety: search up to 4 years worth of minutes (~2.1M iterations max).
  const MAX_CRON_SEARCH_YEARS = 4;
  const maxIterations = MAX_CRON_SEARCH_YEARS * 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    let month: number, dayOfMonth: number, dayOfWeek: number, hour: number, minute: number;
    if (useIntlTz) {
      const local = getLocalParts(d, timezone!);
      month = local.month;
      dayOfMonth = local.day;
      dayOfWeek = local.dow;
      hour = local.hour;
      minute = local.minute;
    } else {
      // Local time — uses machine timezone automatically
      month = d.getMonth() + 1;
      dayOfMonth = d.getDate();
      dayOfWeek = d.getDay();
      hour = d.getHours();
      minute = d.getMinutes();
    }

    // Check all cron fields
    if (!cron.months.includes(month) ||
        !cron.daysOfMonth.includes(dayOfMonth) ||
        !cron.daysOfWeek.includes(dayOfWeek) ||
        !cron.hours.includes(hour) ||
        !cron.minutes.includes(minute)) {
      if (useIntlTz) {
        // When using explicit timezones, advance one minute at a time to avoid
        // UTC-vs-local mismatches in the fast-forward logic.
        d.setUTCMinutes(d.getUTCMinutes() + 1);
      } else {
        // Local time — use fast-forward optimizations
        if (!cron.months.includes(month)) {
          advanceToNextMonthLocal(d, cron.months);
        } else if (!cron.daysOfMonth.includes(dayOfMonth) || !cron.daysOfWeek.includes(dayOfWeek)) {
          d.setDate(d.getDate() + 1);
          d.setHours(0, 0, 0, 0);
        } else if (!cron.hours.includes(hour)) {
          const nextHour = findNext(cron.hours, hour);
          if (nextHour !== null) {
            d.setHours(nextHour, 0, 0, 0);
          } else {
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0, 0, 0);
          }
        } else {
          const nextMin = findNext(cron.minutes, minute);
          if (nextMin !== null) {
            d.setMinutes(nextMin, 0, 0);
          } else {
            d.setHours(d.getHours() + 1, 0, 0, 0);
          }
        }
      }
      continue;
    }

    // All fields match!
    return new Date(d.getTime());
  }

  return null;
}

/**
 * Convenience: parse a cron expression and compute the next run time.
 *
 * @param expression — 5-field cron expression string.
 * @param after — Reference date (defaults to `new Date()`).
 * @returns The next matching Date, or `null` if no match within 4 years.
 * @throws {Error} if the cron expression is invalid.
 */
export function nextCronTickFromExpression(
  expression: string,
  after: Date = new Date(),
  timezone?: string,
): Date | null {
  const cron = parseCron(expression);
  return nextCronTick(cron, after, timezone);
}

/**
 * Calculate the most recent time the cron schedule would have fired at or
 * before `before`.
 *
 * Walks backward from `before` minute-by-minute until a matching slot is
 * found, up to a 4-year window.
 *
 * @param cron   — Parsed cron schedule.
 * @param before — The reference date. The returned date will be at or before this.
 * @returns The most recent matching `Date`, or `null` if no match within the search window.
 */
export function previousCronTick(cron: ParsedCron, before: Date, timezone?: string): Date | null {
  const d = new Date(before.getTime());
  const useIntlTz = !!timezone;

  // Snap to current minute (floor)
  d.setSeconds(0, 0);

  const MAX_CRON_SEARCH_YEARS = 4;
  const maxIterations = MAX_CRON_SEARCH_YEARS * 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    let month: number, dayOfMonth: number, dayOfWeek: number, hour: number, minute: number;
    if (useIntlTz) {
      const local = getLocalParts(d, timezone!);
      month = local.month;
      dayOfMonth = local.day;
      dayOfWeek = local.dow;
      hour = local.hour;
      minute = local.minute;
    } else {
      month = d.getMonth() + 1;
      dayOfMonth = d.getDate();
      dayOfWeek = d.getDay();
      hour = d.getHours();
      minute = d.getMinutes();
    }

    if (
      cron.months.includes(month) &&
      cron.daysOfMonth.includes(dayOfMonth) &&
      cron.daysOfWeek.includes(dayOfWeek) &&
      cron.hours.includes(hour) &&
      cron.minutes.includes(minute)
    ) {
      return new Date(d.getTime());
    }

    // Step back one minute
    d.setMinutes(d.getMinutes() - 1);
  }

  return null;
}

/**
 * Convenience: parse a cron expression and compute the previous run time.
 *
 * @param expression — 5-field cron expression string.
 * @param before — Reference date (defaults to `new Date()`).
 * @returns The most recent matching Date, or `null` if no match within 4 years.
 * @throws {Error} if the cron expression is invalid.
 */
export function previousCronTickFromExpression(
  expression: string,
  before: Date = new Date(),
  timezone?: string,
): Date | null {
  const cron = parseCron(expression);
  return previousCronTick(cron, before, timezone);
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Extract local-time components from a UTC Date in the given IANA timezone.
 * Uses `Intl.DateTimeFormat` — no external dependencies required.
 */
function getLocalParts(
  d: Date,
  tz: string,
): { year: number; month: number; day: number; dow: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);

  const weekdayStr = parts.find((p) => p.type === "weekday")!.value;
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    year: get("year"),
    month: get("month"),      // 1-12
    day: get("day"),           // 1-31
    dow: dowMap[weekdayStr]!,  // 0-6
    hour: get("hour") % 24,   // 0-23 (hour12:false can return 24 for midnight in some locales)
    minute: get("minute"),     // 0-59
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the next value in `sortedValues` that is greater than `current`.
 * Returns `null` if no such value exists.
 */
function findNext(sortedValues: number[], current: number): number | null {
  for (const v of sortedValues) {
    if (v > current) return v;
  }
  return null;
}

/**
 * Advance `d` (mutated in place) to midnight UTC of the first day of the next
 * month whose 1-based month number is in `months`.
 */
function advanceToNextMonth(d: Date, months: number[]): void {
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1; // 1-based

  // Walk months forward until we find one in the set (max 48 iterations = 4 years)
  for (let i = 0; i < 48; i++) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (months.includes(month)) {
      d.setUTCFullYear(year, month - 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return;
    }
  }
}

/**
 * Like advanceToNextMonth but using local time methods.
 */
function advanceToNextMonthLocal(d: Date, months: number[]): void {
  let year = d.getFullYear();
  let month = d.getMonth() + 1; // 1-based

  for (let i = 0; i < 48; i++) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (months.includes(month)) {
      d.setFullYear(year, month - 1, 1);
      d.setHours(0, 0, 0, 0);
      return;
    }
  }
}
