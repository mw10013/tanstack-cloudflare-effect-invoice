import { Effect, Layer, Option, Schedule, Schema, ServiceMap } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

export class R2 extends ServiceMap.Service<R2>()("R2", {
  make: Effect.gen(function* () {
    const { R2: r2 } = yield* CloudflareEnv;
    const head = Effect.fn("R2.head")(function* (key: string) {
      return yield* tryR2(() => r2.head(key)).pipe(
        Effect.map(Option.fromNullishOr),
      );
    });
    const get = Effect.fn("R2.get")(function* (
      key: string,
      options?: R2GetOptions,
    ) {
      return yield* tryR2(() => r2.get(key, options)).pipe(
        Effect.map(Option.fromNullishOr),
      );
    });
    const put = Effect.fn("R2.put")(function* (
      key: string,
      value:
        | ReadableStream
        | ArrayBuffer
        | ArrayBufferView
        | string
        | null
        | Blob,
      options?: R2PutOptions,
    ) {
      return yield* tryR2(() => r2.put(key, value, options));
    });
    const del = Effect.fn("R2.delete")(function* (keys: string | string[]) {
      return yield* tryR2(() => r2.delete(keys));
    });
    const list = Effect.fn("R2.list")(function* (options?: R2ListOptions) {
      return yield* tryR2(() => r2.list(options));
    });
    return { head, get, put, delete: del, list };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class R2Error extends Schema.TaggedErrorClass<R2Error>()("R2Error", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

const RETRYABLE_R2_CODES = ["(10001)", "(10043)", "(10054)", "(10058)"] as const;

const isRetryable = (message: string) =>
  RETRYABLE_R2_CODES.some((code) => message.includes(code)) ||
  message.toLowerCase().includes("network connection lost");

const tryR2 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new R2Error({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.retry({
      while: (error) => isRetryable(error.message),
      times: 2,
      schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
    }),
  );
