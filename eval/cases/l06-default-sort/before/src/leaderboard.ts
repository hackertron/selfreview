export function topScores(scores: number[], n = 10): number[] {
  const sorted = [...scores];
  sorted.sort((a, b) => b - a);
  return sorted.slice(0, n);
}
