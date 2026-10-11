export function topScores(scores: number[], n = 10): number[] {
  return [...scores].sort().reverse().slice(0, n);
}
