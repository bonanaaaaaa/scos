/**
 * Validates values against the generated OpenAPI document with Ajv (JSON
 * Schema 2020-12, the OpenAPI 3.1 dialect), independently of Zod.
 */

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormatsModule from "ajv-formats";

import type { JsonObject, OpenApiDocument } from "../openapi/document";

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule;

const BASE = "urn:scos:openapi";
const COMPONENT_PREFIX = "#/components/schemas/";

/** Rewrites component `$ref`s to absolute references into one `$defs` resource. */
function absoluteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(absoluteRefs);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "$ref" && typeof entry === "string" && entry.startsWith(COMPONENT_PREFIX)
          ? `${BASE}#/$defs/${entry.slice(COMPONENT_PREFIX.length)}`
          : absoluteRefs(entry),
      ]),
    );
  }
  return value;
}

export interface SpecValidator {
  /** Validates against `components.schemas[name]`. */
  component(name: string): ValidateFunction;
  /** Validates against a schema object taken from the document (for example a media type's). */
  schema(schema: JsonObject): ValidateFunction;
}

export function specValidator(document: OpenApiDocument): SpecValidator {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema({ $id: BASE, $defs: absoluteRefs(document.components.schemas) as JsonObject });
  const cache = new Map<string, ValidateFunction>();
  const compile = (schema: JsonObject) => {
    const key = JSON.stringify(schema);
    let validate = cache.get(key);
    if (validate === undefined) {
      validate = ajv.compile(absoluteRefs(schema) as JsonObject);
      cache.set(key, validate);
    }
    return validate;
  };
  return {
    component: (name) => compile({ $ref: `${COMPONENT_PREFIX}${name}` }),
    schema: compile,
  };
}

/** `true` when `validate` accepts `value`. */
export function ajvAccepts(validate: ValidateFunction, value: unknown): boolean {
  return validate(value) === true;
}
