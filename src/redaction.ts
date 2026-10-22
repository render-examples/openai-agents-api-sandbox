const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\brnd_[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

export class Redactor {
  private readonly secrets: string[];

  constructor(secretValues: readonly string[]) {
    this.secrets = [...new Set(secretValues.filter((value) => value.length > 0))].sort(
      (a, b) => b.length - a.length,
    );
  }

  text(value: string): string {
    let redacted = value;
    for (const secret of this.secrets) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    for (const pattern of TOKEN_PATTERNS) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted;
  }

  value<T>(value: T): T {
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }

  assertSafeBytes(data: Uint8Array, source: string): void {
    for (const secret of this.secrets) {
      if (Buffer.from(data).includes(Buffer.from(secret))) {
        throw new Error(`Refusing to save ${source}: it contains a configured secret`);
      }
    }
  }
}
