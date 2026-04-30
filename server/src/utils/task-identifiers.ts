const TASK_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/i;

export function isTaskIdentifier(value: string): boolean {
  return TASK_IDENTIFIER_PATTERN.test(value.trim());
}
