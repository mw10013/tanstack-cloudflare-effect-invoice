import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
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

export const Route = createFileRoute("/login")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const demoMode = yield* Config.boolean("DEMO_MODE").pipe(
          Config.withDefault(false),
        );
        return { isDemoMode: demoMode };
      }),
    ),
);

const loginSchema = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
});

export const login = createServerFn({
  method: "POST",
})
  .inputValidator(Schema.toStandardSchemaV1(loginSchema))
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* Request;
        const auth = yield* Auth;
        const demoMode = yield* Config.boolean("DEMO_MODE").pipe(
          Config.withDefault(false),
        );

        const result = yield* Effect.tryPromise(() =>
          auth.api.signInMagicLink({
            headers: request.headers,
            body: { email: data.email, callbackURL: "/magic-link" },
          }),
        );
        if (!result.status) {
          return yield* Effect.fail(
            new Error("Failed to send magic link. Please try again."),
          );
        }
        const magicLink = demoMode
          ? ((yield* (yield* KV).get("demo:magicLink")) ?? undefined)
          : undefined;
        yield* Effect.logInfo("auth.magicLink.generated", { magicLink });
        return { success: true as const, magicLink };
      }),
    ),
  );

function RouteComponent() {
  const { isDemoMode } = Route.useLoaderData();
  const isHydrated = useHydrated();
  const loginServerFn = useServerFn(login);
  const defaultValues = {
    email: "",
  } satisfies typeof loginSchema.Type;

  const loginMutation = useMutation({
    mutationFn: (data: typeof defaultValues) => loginServerFn({ data }),
  });
  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: Schema.toStandardSchemaV1(loginSchema),
    },
    onSubmit: ({ value }) => {
      console.log(`onSubmit: value: ${JSON.stringify(value)}`);
      void loginMutation.mutateAsync(value);
    },
  });

  if (loginMutation.data?.success) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Check your email</CardTitle>
            <CardDescription>
              If an account exists for that email, a magic sign-in link has been
              sent.
            </CardDescription>
          </CardHeader>
        </Card>
        {loginMutation.data.magicLink && (
          <div className="mt-4">
            <a href={loginMutation.data.magicLink} className="block">
              {loginMutation.data.magicLink}
            </a>
          </div>
        )}
      </div>
    );
  }

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
            id="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              {loginMutation.error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {loginMutation.error.message}
                  </AlertDescription>
                </Alert>
              )}
              <form.Field name="email">
                {(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        type="email"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                        }}
                        placeholder="m@example.com"
                        aria-invalid={isInvalid}
                        disabled={!isHydrated}
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
                    form="login-form"
                    disabled={
                      !isHydrated || !canSubmit || loginMutation.isPending
                    }
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
