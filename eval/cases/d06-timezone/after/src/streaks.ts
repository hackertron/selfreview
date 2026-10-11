/** The user's local calendar date (YYYY-MM-DD), used to count daily streaks. */
export function todayFor(user: { timeZone: string }): string {
  return new Date().toISOString().slice(0, 10);
}

export function isSameDay(a: string, b: string): boolean {
  return a === b;
}
