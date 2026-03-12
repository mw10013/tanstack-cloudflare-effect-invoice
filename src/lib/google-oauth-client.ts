import { Data, Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import * as Oidc from "openid-client";

export class GoogleOAuthError extends Data.TaggedError("GoogleOAuthError")<{
  readonly reason:
    | "Discovery"
    | "AuthorizationBuild"
    | "TokenExchange"
    | "TokenRefresh";
  readonly cause?: unknown;
}> {}

export interface GoogleOAuthClientInput {
  clientId: string;
  clientSecret: Redacted.Redacted;
  redirectUri: string;
}

export interface GoogleAuthorizationInput extends GoogleOAuthClientInput {
  scope: readonly string[];
}

const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
});

let cachedConfig: Oidc.Configuration | undefined;
let cachedConfigKey: string | undefined;

const getGoogleOidcConfig = ({
  clientId,
  clientSecret,
}: GoogleOAuthClientInput) =>
  Effect.tryPromise({
    try: async () => {
      const secret = Redacted.value(clientSecret);
      const configKey = `${clientId}:${secret}`;
      if (cachedConfig && cachedConfigKey === configKey) {
        return cachedConfig;
      }
      const config = await Oidc.discovery(
        new URL("https://accounts.google.com"),
        clientId,
        secret,
      );
      cachedConfig = config;
      cachedConfigKey = configKey;
      return config;
    },
    catch: (cause) => new GoogleOAuthError({ reason: "Discovery", cause }),
  });

export const buildGoogleAuthorizationRequest = (
  input: GoogleAuthorizationInput,
) =>
  Effect.gen(function* () {
    const config = yield* getGoogleOidcConfig(input);
    const state = Oidc.randomState();
    const codeVerifier = Oidc.randomPKCECodeVerifier();
    const codeChallenge = yield* Effect.tryPromise({
      try: () => Oidc.calculatePKCECodeChallenge(codeVerifier),
      catch: (cause) =>
        new GoogleOAuthError({ reason: "AuthorizationBuild", cause }),
    });
    const authorizationUrl = Oidc.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: input.scope.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return {
      state,
      codeVerifier,
      authorizationUrl: authorizationUrl.toString(),
    };
  });

export const exchangeGoogleAuthorizationCode = (
  input: GoogleOAuthClientInput & {
    currentUrl: URL | Request;
    codeVerifier: string;
    expectedState: string;
  },
) =>
  Effect.gen(function* () {
    const config = yield* getGoogleOidcConfig(input);
    const tokenResponse = yield* Effect.tryPromise({
      try: () =>
        Oidc.authorizationCodeGrant(
          config,
          input.currentUrl,
          {
            pkceCodeVerifier: input.codeVerifier,
            expectedState: input.expectedState,
          },
          { redirect_uri: input.redirectUri },
        ),
      catch: (cause) =>
        new GoogleOAuthError({ reason: "TokenExchange", cause }),
    });
    return Schema.decodeUnknownSync(GoogleTokenResponse)(tokenResponse);
  });

export const refreshGoogleToken = (
  input: GoogleOAuthClientInput & { refreshToken: string },
) =>
  Effect.gen(function* () {
    const config = yield* getGoogleOidcConfig(input);
    const tokenResponse = yield* Effect.tryPromise({
      try: () => Oidc.refreshTokenGrant(config, input.refreshToken),
      catch: (cause) => new GoogleOAuthError({ reason: "TokenRefresh", cause }),
    });
    return Schema.decodeUnknownSync(GoogleTokenResponse)(tokenResponse);
  });
