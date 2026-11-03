import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, PageLoading } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setCategoryArchivedAction } from "@/features/categories/actions";
import {
  CreateCategoryForm,
  RenameCategoryForm,
} from "@/features/categories/category-forms";
import { DefaultCategoriesButton } from "@/features/categories/default-categories-button";
import { requireOwner } from "@/server/auth/session";
import { type CategoryRecord, finance } from "@/server/finance";

export const metadata: Metadata = { title: "Categories" };

export default function CategoriesPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Categories"
        description="Income and expense categories. Archived ones stay on past transactions."
      />
      <Suspense fallback={<PageLoading label="Loading categories…" />}>
        <Categories />
      </Suspense>
    </div>
  );
}

function CategoryGroup({
  title,
  categories,
}: {
  title: string;
  categories: readonly CategoryRecord[];
}) {
  return (
    <section aria-label={title} className="grid gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : null}
      <ul className="divide-y rounded-lg border">
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span className="flex items-center gap-2">
              <RenameCategoryForm id={c.id} name={c.name} />
              {c.archivedAt ? (
                <Badge variant="secondary">Archived</Badge>
              ) : null}
            </span>
            <form action={setCategoryArchivedAction}>
              <input type="hidden" name="categoryId" value={c.id} />
              <input
                type="hidden"
                name="archived"
                value={c.archivedAt ? "false" : "true"}
              />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                aria-label={`${c.archivedAt ? "Restore" : "Archive"} ${c.name}`}
              >
                {c.archivedAt ? "Restore" : "Archive"}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Categories() {
  const owner = await requireOwner();
  const categories = await finance.listCategories(owner);
  return (
    <div className="grid gap-8">
      {categories.length === 0 ? (
        <div className="grid gap-3 rounded-lg border border-dashed p-6">
          <p className="font-medium">No categories yet</p>
          <p className="text-sm text-muted-foreground">
            Start with a standard set (Salary, Groceries, Rent and more), or add
            your own below.
          </p>
          <div>
            <DefaultCategoriesButton />
          </div>
        </div>
      ) : null}
      <CreateCategoryForm />
      <CategoryGroup
        title="Expense categories"
        categories={categories.filter((c) => c.kind === "expense")}
      />
      <CategoryGroup
        title="Income categories"
        categories={categories.filter((c) => c.kind === "income")}
      />
    </div>
  );
}
