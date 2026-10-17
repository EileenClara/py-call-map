export function lineToIndex(line: number): number {
  return Math.max(0, line - 1);
}

export function indexToLine(index: number): number {
  return index + 1;
}
