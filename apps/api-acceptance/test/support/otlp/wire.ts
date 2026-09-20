/**
 * A minimal protobuf wire-format reader.
 *
 * The API under test exports telemetry as OTLP/HTTP with protobuf payloads,
 * so the suite's fake collector has to decode protobuf to see what was
 * exported. Only the wire format is implemented here — field numbers and
 * message shapes live in ./decode.ts — and only the four wire types OTLP
 * uses. There is deliberately no dependency on a protobuf library or on
 * `@opentelemetry/*`, so nothing here can agree with the server under test by
 * sharing its telemetry code. (The suite does share `pg` and
 * `@scos/persistence` with it, to reach the database and seed it.)
 *
 * The reader is total: every path either returns a value or throws with the
 * position and the reason. A test decoder that silently mis-parses would be
 * worse than one that fails, since it would quietly weaken every assertion
 * made on its output.
 *
 * @module
 */

/**
 * The wire types OTLP payloads use:
 * 0 varint, 1 64-bit, 2 length-delimited, 5 32-bit. Groups (3 and 4) are
 * deprecated, never emitted by the exporters, and rejected below.
 */
export type WireType = 0 | 1 | 2 | 5;

/**
 * One encoded field. The value's type follows the wire type, so a decoder
 * reading `field.value` cannot mistake a length-delimited message for a
 * number:
 * - `0` the varint, as a bigint (unsigned; {@link asSigned} reads int64s)
 * - `1` the eight little-endian bytes (fixed64, sfixed64 or double)
 * - `2` the bytes (an embedded message, a string, or a packed array)
 * - `5` the 32-bit value, unsigned
 */
export type WireField =
  | { readonly fieldNumber: number; readonly wireType: 0; readonly value: bigint }
  | { readonly fieldNumber: number; readonly wireType: 1; readonly value: Buffer }
  | { readonly fieldNumber: number; readonly wireType: 2; readonly value: Buffer }
  | { readonly fieldNumber: number; readonly wireType: 5; readonly value: number };

/** A varint is at most ten bytes (64 bits at seven bits per byte). */
const MAX_VARINT_BYTES = 10;

/** Reads one protobuf message from a buffer, one field at a time. */
export class WireReader {
  private position = 0;

  constructor(private readonly buffer: Buffer) {}

  /** True once every byte of the message has been consumed. */
  atEnd(): boolean {
    return this.position >= this.buffer.length;
  }

  /** The next `count` bytes as a view (never a copy), bounds-checked. */
  private take(count: number): Buffer {
    const end = this.position + count;
    if (end > this.buffer.length) {
      throw new Error(
        `Truncated OTLP payload: ${String(count)} bytes wanted at ${String(this.position)}, ` +
          `${String(this.buffer.length - this.position)} left`,
      );
    }
    const slice = this.buffer.subarray(this.position, end);
    this.position = end;
    return slice;
  }

  /** A base-128 varint, exact: accumulated into a bigint, never a double. */
  readVarint(): bigint {
    let value = 0n;
    for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
      const byte = this.buffer[this.position];
      if (byte === undefined) {
        throw new Error(`Truncated OTLP payload: varint ends at ${String(this.position)}`);
      }
      this.position += 1;
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
    throw new Error(`Malformed OTLP payload: varint longer than ${String(MAX_VARINT_BYTES)} bytes`);
  }

  /** The eight bytes of a fixed64, sfixed64 or double, little-endian. */
  readFixed64(): Buffer {
    return this.take(8);
  }

  /** A fixed32, unsigned. */
  readFixed32(): number {
    return this.take(4).readUInt32LE(0);
  }

  /** The bytes of a length-delimited field: a string, message or packed array. */
  readLengthDelimited(): Buffer {
    return this.take(Number(this.readVarint()));
  }

  /** A field tag, split into its field number and wire type. */
  readTag(): { readonly fieldNumber: number; readonly wireType: WireType } {
    const at = this.position;
    const tag = this.readVarint();
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0) {
      throw new Error(`Malformed OTLP payload: field number 0 at ${String(at)}`);
    }
    if (wireType !== 0 && wireType !== 1 && wireType !== 2 && wireType !== 5) {
      throw new Error(
        `Unsupported OTLP wire type ${String(wireType)} for field ${String(fieldNumber)} at ${String(at)}`,
      );
    }
    return { fieldNumber, wireType };
  }

  /**
   * Steps over the value of the field whose tag was just read, without
   * interpreting it. Every wire type has a self-describing length, so an
   * unknown field can always be stepped over exactly.
   */
  skipField(wireType: WireType): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.take(8);
        return;
      case 2:
        this.readLengthDelimited();
        return;
      case 5:
        this.take(4);
        return;
    }
  }
}

/**
 * Walks an encoded message and yields the fields whose numbers are in
 * `wanted`; every other field is stepped over with
 * {@link WireReader.skipField}. Each decoder therefore names exactly the
 * fields it understands, and a field added to OTLP later is ignored rather
 * than guessed at.
 */
export function* fields(buffer: Buffer, wanted: ReadonlySet<number>): Generator<WireField> {
  const reader = new WireReader(buffer);
  while (!reader.atEnd()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (!wanted.has(fieldNumber)) {
      reader.skipField(wireType);
      continue;
    }
    switch (wireType) {
      case 0:
        yield { fieldNumber, wireType, value: reader.readVarint() };
        break;
      case 1:
        yield { fieldNumber, wireType, value: reader.readFixed64() };
        break;
      case 2:
        yield { fieldNumber, wireType, value: reader.readLengthDelimited() };
        break;
      case 5:
        yield { fieldNumber, wireType, value: reader.readFixed32() };
        break;
    }
  }
}

/** Two to the sixty-fourth, for reading a varint or fixed64 as a signed int64. */
const TWO_TO_THE_64 = 1n << 64n;

/** A varint read as a signed int64 (protobuf stores negatives two's complement). */
export function asSigned(value: bigint): bigint {
  return value >= TWO_TO_THE_64 >> 1n ? value - TWO_TO_THE_64 : value;
}

/** A fixed64 field as an unsigned integer (timestamps, counts). */
export function asUint64(value: Buffer): bigint {
  return value.readBigUInt64LE(0);
}

/** An sfixed64 field as a signed integer (a counter's `as_int`). */
export function asSfixed64(value: Buffer): bigint {
  return value.readBigInt64LE(0);
}

/** A fixed64 field as an IEEE 754 double (`as_double`, a histogram `sum`). */
export function asDouble(value: Buffer): number {
  return value.readDoubleLE(0);
}

/** A length-delimited field as UTF-8 text. */
export function asText(value: Buffer): string {
  return value.toString("utf8");
}

/** A bytes field as lowercase hex: how trace and span ids are written in logs. */
export function asHex(value: Buffer): string {
  return value.toString("hex");
}

/** A packed repeated fixed64 field (a histogram's `bucket_counts`). */
export function packedFixed64(value: Buffer): bigint[] {
  const reader = new WireReader(value);
  const values: bigint[] = [];
  while (!reader.atEnd()) {
    values.push(asUint64(reader.readFixed64()));
  }
  return values;
}

/** A packed repeated double field (a histogram's `explicit_bounds`). */
export function packedDoubles(value: Buffer): number[] {
  const reader = new WireReader(value);
  const values: number[] = [];
  while (!reader.atEnd()) {
    values.push(asDouble(reader.readFixed64()));
  }
  return values;
}
