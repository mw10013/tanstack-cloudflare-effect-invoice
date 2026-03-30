import { Array as Arr, Option, pipe, Schema, SchemaGetter, SchemaTransformation, Struct } from "effect";

/**
 * A Struct.Lambda is a type-level function interface used by Struct.map/mapPick/mapOmit
 * so TypeScript can track how value types change when transforming struct fields.
 *
 * - The call signature `<S>(self: S): S` defines the runtime behavior's type.
 * - `"~lambda.in"` / `"~lambda.out"` are type-level "registers" that Struct.Apply reads:
 *   it sets `~lambda.in` to the input type and reads `~lambda.out` for the result type.
 * - Here `~lambda.out: this["~lambda.in"]` means "output type = input type" (identity),
 *   so `Struct.map(fields, trimStringSchema)` preserves each field's schema type.
 * - `Struct.lambda<L>(fn)` wraps a plain function with the Lambda type (zero runtime cost).
 */
interface TrimStringSchema extends Struct.Lambda {
  <S extends Schema.Schema<string>>(self: S): S;
  readonly "~lambda.out": this["~lambda.in"];
}

export const trimFields = <F extends Record<string, Schema.Schema<string>>>(fields: F): F =>
  pipe(fields, Struct.map(Struct.lambda<TrimStringSchema>((s) => s.pipe(Schema.decode(SchemaTransformation.trim())))));

/**
 * Extract a single field from a struct schema, returning the unwrapped value.
 *
 * refs/effect4/packages/effect/SCHEMA.md:7262
 */
const pluck =
  <P extends PropertyKey>(key: P) =>
  <S extends Schema.Top>(
    schema: Schema.Struct<Record<P, S>>,
  ): Schema.decodeTo<Schema.toType<S>, Schema.Struct<Record<P, S>>> =>
    schema.mapFields(Struct.pick([key])).pipe(
      Schema.decodeTo(Schema.toType(schema.fields[key]), {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        decode: SchemaGetter.transform((whole: any) => whole[key]),
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        encode: SchemaGetter.transform((value) => ({ [key]: value }) as any),
      }),
    );

/**
 * Schema for structs with a `{ data: string }` field containing serialized JSON.
 * Extracts the `data` field, parses the JSON string, and decodes against `DataSchema`.
 *
 * Uses `<S extends Schema.Top>` instead of `<A>(Schema.Schema<A>)` to preserve
 * the concrete schema type through the pipeline. `Schema.Schema<A>` erases
 * `DecodingServices` to `unknown` (inherited from `Schema.Top`), which causes
 * `Schema.decodeUnknownEffect` to infer `R = unknown` instead of `R = never`.
 */
export const JsonDataField = <S extends Schema.Top>(DataSchema: S) =>
  Schema.Struct({ data: Schema.String }).pipe(
    pluck("data"),
    Schema.decodeTo(Schema.fromJsonString(DataSchema)),
  );

/**
 * Schema for an array of structs with a `{ data: string }` field.
 * Takes the head element, extracts and decodes its JSON `data` field against `DataSchema`.
 * Returns `Option.none` for an empty array, `Option.some(decoded)` otherwise.
 */
export const JsonDataFieldHead = <S extends Schema.Top>(DataSchema: S) => {
  const RowSchema = JsonDataField(DataSchema);
  return Schema.Array(RowSchema).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(RowSchema)),
      SchemaTransformation.transform({
        decode: Arr.head,
        encode: Option.match({
          onNone: () => [],
          onSome: (item) => [item],
        }),
      }),
    ),
  );
};
