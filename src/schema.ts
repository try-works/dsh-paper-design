/**
 * JSON Schema normalization: Paper's raw `inputSchema` vocabulary -> the enforced
 * DSH subset. Paper advertises draft-2020-12 schemas carrying keywords the
 * harness rejects (see @deepseek-ai/dsh-tools/src/json-schema.ts):
 *
 *   - unsupported keywords: $schema, format, pattern, propertyNames,
 *     minLength, maxLength, minimum, maximum, minItems
 *   - `anyOf` (no `anyOf` keyword in the subset) -> `oneOf`
 *
 * The registry does NOT validate raw ToolDefinition `parameters` against the
 * declared schema (only `output.schema` is asserted at register time), but the
 * Code Mode SDK generator projects `parameters` to TypeScript through the same
 * enforced subset and adapters read the schema, so normalizing before
 * registration keeps the model-facing contract well-formed and stable.
 *
 * @module dsh-paper-design/src/schema
 */

import { assertSupportedJsonSchema, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Keywords the enforced subset rejects outright; their constraints are dropped. */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'format',
  'pattern',
  'propertyNames',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
])

/** Keywords that may not appear beside oneOf in the enforced subset. */
const ONE_OF_SIBLINGS = new Set(['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])

/** Single scalar type strings the subset accepts. */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

type SchemaType = (typeof SCHEMA_TYPES)[number]

const SCALAR_TYPES: ReadonlySet<SchemaType> = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/** Whether a value survives a lossless JSON materialization boundary. */
function isLosslessJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) return false
      if (!isLosslessJsonValue(value[i])) return false
    }
    return true
  }
  if (isPlainObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false
      if (!isLosslessJsonValue((value as Record<string, unknown>)[key])) return false
    }
    return true
  }
  return false
}

/** Resolve a raw `type` field (string or array) to one subset scalar, else undefined. */
function resolveType(value: unknown): SchemaType | undefined {
  if (typeof value === 'string' && (SCHEMA_TYPES as readonly string[]).includes(value)) return value as SchemaType
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && (SCHEMA_TYPES as readonly string[]).includes(entry)) return entry as SchemaType
    }
  }
  return undefined
}

function scalarMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/** True when a normalized branch is the unconstrained annotation-only form. */
function isAnyBranch(node: Record<string, unknown>): boolean {
  return !Object.hasOwn(node, 'type') && !Object.hasOwn(node, 'oneOf')
}

/**
 * Normalize one raw JSON Schema node into the enforced subset. Pure and
 * total: hostile or malformed input degrades toward the annotation-only
 * unconstrained form rather than throwing, then the caller asserts the
 * result through {@link assertSupportedJsonSchema}.
 * @param input - raw untrusted schema node (any JSON value).
 * @returns a subset-conformant node.
 */
export function normalizeSchema(input: unknown): JsonSchemaNode {
  if (!isPlainObject(input)) return {}

  const node: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue
    node[key] = value
  }

  // additionalProperties is boolean-only in the subset; a schema-form value
  // (open-ended) collapses to true, matching JSON Schema's open default.
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    if (isPlainObject(node.additionalProperties) && (node.additionalProperties as Record<string, unknown>).type === 'false') {
      node.additionalProperties = false
    } else {
      node.additionalProperties = true
    }
  }

  // anyOf -> oneOf. Inline a single surviving branch; a branch that degrades
  // to "any" makes the whole union match everything, so drop the union.
  if (Object.hasOwn(node, 'anyOf')) {
    const branches = Array.isArray(node.anyOf)
      ? node.anyOf.map(normalizeSchema).filter(b => !isAnyBranch(b as unknown as Record<string, unknown>))
      : []
    delete node.anyOf
    if (branches.length === 1) {
      for (const [key, value] of Object.entries(branches[0]!)) node[key] = value
    } else if (branches.length >= 2) {
      node.oneOf = branches
    }
  }

  // The subset forbids structural keywords beside oneOf. When both appear,
  // the object structure is authoritative and the union is dropped.
  if (Object.hasOwn(node, 'oneOf') && ONE_OF_SIBLINGS.has(Object.keys(node).find(k => ONE_OF_SIBLINGS.has(k)) ?? '')) {
    delete node.oneOf
  }

  if (Object.hasOwn(node, 'type')) {
    const type = resolveType(node.type)
    if (type === undefined) delete node.type
    else node.type = type
  }

  // enum/const must be scalar and type-correct; filter or drop mismatches.
  const type = Object.hasOwn(node, 'type') ? node.type as SchemaType | undefined : undefined
  if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      delete node.enum
    } else if (type !== undefined && SCALAR_TYPES.has(type)) {
      const filtered = node.enum.filter(entry => scalarMatches(type, entry))
      if (filtered.length === 0) delete node.enum
      else node.enum = filtered
    }
  }
  if (Object.hasOwn(node, 'const')) {
    if (type !== undefined && SCALAR_TYPES.has(type) && !scalarMatches(type, node.const)) delete node.const
  }

  // required must name only declared properties.
  if (Object.hasOwn(node, 'required') && Array.isArray(node.required) && isPlainObject(node.properties)) {
    const declared = node.properties
    const filtered = node.required.filter(entry => typeof entry === 'string' && Object.hasOwn(declared, entry))
    if (filtered.length === 0) delete node.required
    else node.required = filtered
  } else if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
    delete node.required
  }

  // Recurse into child schemas.
  if (isPlainObject(node.properties)) {
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node.properties)) next[key] = normalizeSchema(child)
    node.properties = next
  } else if (Object.hasOwn(node, 'properties')) {
    delete node.properties
  }
  if (Object.hasOwn(node, 'items')) node.items = normalizeSchema(node.items)

  // Annotations must be lossless JSON; drop ones that are not.
  for (const key of ['default', 'examples']) {
    if (Object.hasOwn(node, key) && !isLosslessJsonValue(node[key])) delete node[key]
  }

  assertSupportedJsonSchema(node)
  return node as unknown as JsonSchemaNode
}

/**
 * Normalize a full tool input schema (the object-rooted form Paper advertises)
 * and assert the result. Falls back to an unconstrained object root when the
 * source is malformed.
 * @param input - raw inputSchema from the MCP tools/list payload.
 * @returns a subset-conformant object-rooted schema.
 */
export function normalizeToolSchema(input: unknown): JsonSchemaNode {
  const normalized = normalizeSchema(input)
  if (!isPlainObject(normalized) || normalized.type !== 'object') {
    return normalizeSchema({ type: 'object', properties: {}, additionalProperties: false })
  }
  return normalized
}
