import type * as HttpClientError from "effect/unstable/http/HttpClientError";

import { Data, Effect } from "effect";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export class GoogleApiError extends Data.TaggedError("GoogleApiError")<{
  readonly code: number;
  readonly message: string;
  readonly status?: string;
}> {}

const GoogleApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    status: Schema.optionalKey(Schema.String),
  }),
});

const toGoogleApiError = (
  error: HttpClientError.HttpClientError,
): Effect.Effect<never, GoogleApiError> => {
  const fallback = new GoogleApiError({
    code: error.response?.status ?? 0,
    message: error.message,
  });
  if (!error.response) return Effect.fail(fallback);
  return error.response.json.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(GoogleApiErrorBody)(json),
    ),
    Effect.flatMap(({ error: e }) => Effect.fail(new GoogleApiError(e))),
    Effect.mapError(() => fallback),
  );
};

const DriveListResponse = Schema.Struct({
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        modifiedTime: Schema.optionalKey(Schema.String),
        webViewLink: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const SheetsValuesResponse = Schema.Struct({
  range: Schema.optionalKey(Schema.String),
  majorDimension: Schema.optionalKey(Schema.String),
  values: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Unknown))),
});

const SheetsAppendResponse = Schema.Struct({
  spreadsheetId: Schema.optionalKey(Schema.String),
  tableRange: Schema.optionalKey(Schema.String),
  updates: Schema.optionalKey(
    Schema.Struct({
      spreadsheetId: Schema.optionalKey(Schema.String),
      updatedRange: Schema.optionalKey(Schema.String),
      updatedRows: Schema.optionalKey(Schema.Number),
      updatedColumns: Schema.optionalKey(Schema.Number),
      updatedCells: Schema.optionalKey(Schema.Number),
    }),
  ),
});

const fetchGoogle = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.catchTag("HttpClientError", toGoogleApiError),
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new GoogleApiError({ code: 0, message: error.message })),
    ),
  );

export const listDriveSpreadsheetsRequest = (
  accessToken: string,
  pageSize = 100,
) => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
  );
  url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
  url.searchParams.set("pageSize", String(pageSize));
  return fetchGoogle(
    HttpClientRequest.get(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      acceptJson: true,
    }),
    DriveListResponse,
  );
};

export const getSpreadsheetValuesRequest = (
  accessToken: string,
  spreadsheetId: string,
  range: string,
) =>
  fetchGoogle(
    HttpClientRequest.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        acceptJson: true,
      },
    ),
    SheetsValuesResponse,
  );

export const appendSpreadsheetValuesRequest = (
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[],
) =>
  fetchGoogle(
    HttpClientRequest.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        acceptJson: true,
        body: HttpBody.jsonUnsafe({ values: [values] }),
      },
    ),
    SheetsAppendResponse,
  );
