import * as React from "react";

import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { ChevronLeftIcon, ChevronRightIcon, Search } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Repository } from "@/lib/Repository";

const LIMIT = 20;

const subscriptionSearchSchema = Schema.Struct({
  page: Schema.Union([
    Schema.Int,
    Schema.NumberFromString.check(Schema.isInt()),
  ])
    .check(Schema.isGreaterThanOrEqualTo(1))
    .pipe(Schema.withDecodingDefaultKey(() => 1)),
  filter: Schema.optional(Schema.Trim),
});

export const getSubscriptions = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(subscriptionSearchSchema))
  .handler(async ({ data, context: { runEffect } }) => {
    const { page, filter } = data;
    const offset = (page - 1) * LIMIT;
    return runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        const result = yield* repository.getSubscriptions({
          limit: LIMIT,
          offset,
          searchValue: filter && filter !== "" ? filter : undefined,
        });
        const pageCount = Math.max(1, Math.ceil(result.count / LIMIT));
        return { subscriptions: result.subscriptions, page, pageCount, filter };
      }),
    );
  });

export const Route = createFileRoute("/admin/subscriptions")({
  validateSearch: Schema.toStandardSchemaV1(subscriptionSearchSchema),
  loaderDeps: ({ search }) => ({ page: search.page, filter: search.filter }),
  loader: async ({ deps }) => {
    const result = await getSubscriptions({ data: deps });
    if (deps.page > result.pageCount) {
      // oxlint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({
        to: "/admin/subscriptions",
        search: { page: result.pageCount, filter: deps.filter },
      });
    }
    return result;
  },
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const search = Route.useSearch();

  const handleFilterSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const filter = formData.get("filter");
    if (typeof filter === "string") {
      void router.navigate({
        to: "/admin/subscriptions",
        search: { filter, page: 1 },
      });
    }
  };

  return (
    <div className="flex flex-col gap-8 p-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscriptions.
        </p>
      </header>

      <form onSubmit={handleFilterSubmit}>
        <InputGroup>
          <InputGroupInput
            name="filter"
            defaultValue={search.filter ?? ""}
            placeholder="Filter by email..."
            aria-label="Filter by email"
          />
          <InputGroupAddon>
            <Search className="size-4" />
          </InputGroupAddon>
        </InputGroup>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">Id</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Stripe Subscription ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.subscriptions.map((subscription) => (
            <TableRow key={subscription.id}>
              <TableCell>{subscription.id}</TableCell>
              <TableCell>{subscription.user.email}</TableCell>
              <TableCell>{subscription.plan}</TableCell>
              <TableCell>{subscription.status}</TableCell>
              <TableCell>
                {subscription.stripeSubscriptionId ? (
                  <a
                    href={`https://dashboard.stripe.com/subscriptions/${subscription.stripeSubscriptionId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {subscription.stripeSubscriptionId}
                  </a>
                ) : (
                  ""
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {data.pageCount > 1 && (
        <Pagination>
          <PaginationContent>
            {data.page > 1 ? (
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => {
                    void router.navigate({
                      to: "/admin/subscriptions",
                      search: {
                        page: data.page - 1,
                        filter: search.filter,
                      },
                    });
                  }}
                />
              </PaginationItem>
            ) : (
              <PaginationItem>
                <span className="inline-flex h-9 items-center px-4 py-2 text-muted-foreground">
                  <ChevronLeftIcon className="mr-1 size-4" />
                  <span className="hidden sm:inline">Previous</span>
                </span>
              </PaginationItem>
            )}
            {Array.from({ length: data.pageCount }, (_, i) => {
              const page = i + 1;
              return (
                <PaginationItem key={page}>
                  <PaginationLink
                    onClick={() => {
                      void router.navigate({
                        to: "/admin/subscriptions",
                        search: { page, filter: search.filter },
                      });
                    }}
                    isActive={page === data.page}
                  >
                    {page}
                  </PaginationLink>
                </PaginationItem>
              );
            })}
            {data.page < data.pageCount ? (
              <PaginationItem>
                <PaginationNext
                  onClick={() => {
                    void router.navigate({
                      to: "/admin/subscriptions",
                      search: {
                        page: data.page + 1,
                        filter: search.filter,
                      },
                    });
                  }}
                />
              </PaginationItem>
            ) : (
              <PaginationItem>
                <span className="inline-flex h-9 items-center px-4 py-2 text-muted-foreground">
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRightIcon className="ml-1 size-4" />
                </span>
              </PaginationItem>
            )}
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
