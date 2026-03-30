import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const searchSchema = Schema.Struct({
  magicLink: Schema.optional(Schema.String),
});

export const Route = createFileRoute("/login1-success")({
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
  component: RouteComponent,
});

function RouteComponent() {
  const { magicLink } = Route.useSearch();

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
      {magicLink && (
        <div className="mt-4">
          <a href={magicLink} className="block">
            {magicLink}
          </a>
        </div>
      )}
    </div>
  );
}
