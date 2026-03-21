import { Layer, Logger, References } from "effect";
import * as Schema from "effect/Schema";

import * as Domain from "@/lib/Domain";

export const makeLoggerLayer = (env: Env) => {
  const environment = Schema.decodeUnknownSync(Domain.Environment)(
    env.ENVIRONMENT,
  );
  return Layer.merge(
    Logger.layer(
      environment === "production"
        ? [Logger.consoleJson, Logger.tracerLogger]
        : [Logger.consolePretty(), Logger.tracerLogger],
      { mergeWithExisting: false },
    ),
    Layer.succeed(
      References.MinimumLogLevel,
      environment === "production" ? "Info" : "Debug",
    ),
  );
};
