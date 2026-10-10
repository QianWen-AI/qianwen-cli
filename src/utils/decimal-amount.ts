import { CliError } from './errors.js';

const SCALE = 10n ** 12n;
const CENT_UNITS = SCALE / 100n;

function invalidAmount(): never {
  throw new CliError({
    code: 'TOKENPLAN_AMOUNT_INVALID',
    message: 'Token Plan amount must be a non-negative decimal with at most 12 decimal places.',
    exitCode: 4,
  });
}

export class DecimalAmount {
  private constructor(private readonly units: bigint) {}

  static parse(value: string): DecimalAmount {
    if (
      typeof value !== 'string' ||
      value.length > 100 ||
      !/^(0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)
    ) {
      return invalidAmount();
    }
    const [integer, fraction = ''] = value.split('.');
    return new DecimalAmount(BigInt(integer) * SCALE + BigInt(fraction.padEnd(12, '0')));
  }

  static fromApi(value: unknown): DecimalAmount {
    if (typeof value === 'string') return DecimalAmount.parse(value);
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      Object.is(value, -0) ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      return invalidAmount();
    }
    const representation = String(value);
    if (!representation.includes('e')) return DecimalAmount.parse(representation);
    const [coefficient, exponentText] = representation.split('e');
    const exponent = Number(exponentText);
    const [integer, fraction = ''] = coefficient.split('.');
    const digits = integer + fraction;
    const point = integer.length + exponent;
    if (point <= 0) return DecimalAmount.parse(`0.${'0'.repeat(-point)}${digits}`);
    if (point >= digits.length)
      return DecimalAmount.parse(digits + '0'.repeat(point - digits.length));
    return DecimalAmount.parse(`${digits.slice(0, point)}.${digits.slice(point)}`);
  }

  add(other: DecimalAmount): DecimalAmount {
    return new DecimalAmount(this.units + other.units);
  }

  subtract(other: DecimalAmount): DecimalAmount {
    if (this.units < other.units) return invalidAmount();
    return new DecimalAmount(this.units - other.units);
  }

  compare(other: DecimalAmount): -1 | 0 | 1 {
    return this.units < other.units ? -1 : this.units > other.units ? 1 : 0;
  }

  min(other: DecimalAmount): DecimalAmount {
    return this.compare(other) <= 0 ? this : other;
  }

  roundToCents(): DecimalAmount {
    return new DecimalAmount(((this.units + CENT_UNITS / 2n) / CENT_UNITS) * CENT_UNITS);
  }

  toCanonicalString(): string {
    const integer = this.units / SCALE;
    const fraction = (this.units % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
    return fraction ? `${integer}.${fraction}` : String(integer);
  }
}
