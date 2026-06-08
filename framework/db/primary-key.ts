import { uuidv7 } from "uuidv7";

export function generatePrimaryKey(): string {
  return uuidv7();
}

const UUID_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidIdentifier(value: string): boolean {
  return UUID_IDENTIFIER_PATTERN.test(value);
}
