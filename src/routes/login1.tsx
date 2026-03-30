import {
  createServerValidate,
  formOptions,
  getFormData,
  mergeForm,
  ServerValidateError,
  useForm,
  useTransform,
} from "@tanstack/react-form-start";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useStore } from "@tanstack/react-store";
import { Config, Effect } from "effect";
import * as Schema from "effect/Schema";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Auth } from "@/lib/Auth";
import { KV } from "@/lib/KV";
import { Request } from "@/lib/Request";

const loginSchema = Schema.Struct({
  email: Schema.String.check(
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, {
      message: "Please enter a valid email address",
    }),
  ),
});

const loginFormOpts = formOptions({
  defaultValues: { email: "" },
});

const serverValidate = createServerValidate({
  ...loginFormOpts,
  onServerValidate: Schema.toStandardSchemaV1(loginSchema),
});

const handleLoginForm = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("Invalid form data");
    return data;
  })
  .handler(async ({ data, context: { runEffect } }) => {
    try {
      // eslint-disable-next-line typescript-eslint/no-unsafe-assignment -- createServerValidate returns any; validated by onServerValidate
      const validatedData = await serverValidate(data);
      const result = await runEffect(
        Effect.gen(function* () {
          const request = yield* Request;
          const auth = yield* Auth;
          const demoMode = yield* Config.boolean("DEMO_MODE").pipe(
            Config.withDefault(false),
          );

          const sendResult = yield* Effect.tryPromise(() =>
            auth.api.signInMagicLink({
              headers: request.headers,
              // eslint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access -- validated by onServerValidate
              body: { email: validatedData.email, callbackURL: "/magic-link" },
            }),
          );
          if (!sendResult.status) {
            return yield* Effect.fail(
              new Error("Failed to send magic link. Please try again."),
            );
          }
          const magicLink = demoMode
            ? ((yield* (yield* KV).get("demo:magicLink")) ?? undefined)
            : undefined;
          yield* Effect.logInfo("auth.magicLink.generated", { magicLink });
          return { magicLink };
        }),
      );
      // oxlint-disable-next-line typescript-eslint(only-throw-error) -- TanStack Router expects redirect() to be thrown as a Response
      throw redirect({
        to: "/login1-success",
        search: result.magicLink ? { magicLink: result.magicLink } : {},
      });
    } catch (error) {
      if (error instanceof ServerValidateError) return error.response;
      throw error;
    }
  });

const getFormDataFromServer = createServerFn({ method: "GET" }).handler(
  async () => getFormData(),
);

const getLoaderData = createServerFn({ method: "GET" }).handler(
  async ({ context: { runEffect } }) => {
    const state = await getFormDataFromServer();
    const { isDemoMode } = await runEffect(
      Effect.gen(function* () {
        const demoMode = yield* Config.boolean("DEMO_MODE").pipe(
          Config.withDefault(false),
        );
        return { isDemoMode: demoMode };
      }),
    );
    return { state, isDemoMode };
  },
);

export const Route = createFileRoute("/login1")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { state, isDemoMode } = Route.useLoaderData();

  const form = useForm({
    ...loginFormOpts,
    transform: useTransform((baseForm) => mergeForm(baseForm, state), [state]),
  });

  const formErrors = useStore(form.store, (formState) => formState.errors);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in / Sign up</CardTitle>
          <CardDescription>
            {isDemoMode
              ? "DEMO MODE: no transactional emails. Use fake email or a@a.com for admin."
              : "Enter your email to receive a magic sign-in link"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={handleLoginForm.url}
            method="post"
            encType="multipart/form-data"
          >
            <FieldGroup>
              {formErrors.flatMap((error, i) => {
                if (typeof error === "string") {
                  return [
                    <Alert key={String(i)} variant="destructive">
                      <AlertCircle className="size-4" />
                      <AlertTitle>Error</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>,
                  ];
                }
                if (error && typeof error === "object") {
                  return Object.values(
                    error as Record<
                      string,
                      { message: string }[] | undefined
                    >,
                  ).flatMap((issues, j) =>
                    (issues ?? []).map((issue) => (
                      <Alert
                        key={`${String(i)}-${String(j)}`}
                        variant="destructive"
                      >
                        <AlertCircle className="size-4" />
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>{issue.message}</AlertDescription>
                      </Alert>
                    )),
                  );
                }
                return [];
              })}
              <form.Field
                name="email"
                validators={{
                  // eslint-disable-next-line unicorn/no-useless-undefined -- noop placeholder while client validation is disabled for testing
                  onBlur: () => undefined,
                  // onBlur: ({ value }) =>
                  // !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                  //   ? { message: "Please enter a valid email address" }
                  //   : undefined,
                }}
              >
                {(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        // type="email"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                        }}
                        placeholder="m@example.com"
                        aria-invalid={isInvalid}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Subscribe selector={(formState) => formState.canSubmit}>
                {(canSubmit) => (
                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full"
                  >
                    Send magic link
                  </Button>
                )}
              </form.Subscribe>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
