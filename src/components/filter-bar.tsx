"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  type: "select" | "text";
  options?: FilterOption[];
  width?: string;
}

export function FilterBar({
  filters,
  exportKind,
  showSearch = true,
  searchPlaceholder = "Search by code, description or project",
  compact = false,
}: {
  filters: FilterDef[];
  exportKind?: string;
  showSearch?: boolean;
  searchPlaceholder?: string;
  /** Tighter spacing, for full-screen tables. */
  compact?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [search, setSearch] = useState(sp.get("search") ?? "");

  const apply = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    start(() => router.push(`?${next.toString()}`));
  };

  // A tab ("view") and a reporting basis are not filters: clearing keeps them.
  const KEEP = ["view", "basis"];
  const clearAll = () => {
    setSearch("");
    const next = new URLSearchParams();
    for (const k of KEEP) {
      const v = sp.get(k);
      if (v) next.set(k, v);
    }
    start(() => router.push(`?${next.toString()}`));
  };

  const activeCount = [...sp.keys()].filter(
    (k) => !["page", "pageSize", "sort", "dir", ...KEEP].includes(k),
  ).length;

  return (
    <div className={compact ? "card mb-2 px-3 py-2" : "card mb-3 px-4 py-3"}>
      <div className={compact ? "flex flex-wrap items-end gap-2" : "flex flex-wrap items-end gap-2.5"}>
        {showSearch && (
          <form
            className="flex w-full items-end gap-1.5 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              apply("search", search);
            }}
          >
            <div className="min-w-0 flex-1">
              <label className="label" htmlFor="filter-search">
                Search
              </label>
              <input
                id="filter-search"
                className={compact ? "input w-full sm:w-64" : "input w-full sm:w-80"}
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button type="submit" className="btn">
              Search
            </button>
          </form>
        )}

        {filters.map((f) => (
          <div key={f.key} style={{ width: f.width ?? "11rem" }}>
            <label className="label" htmlFor={`filter-${f.key}`}>
              {f.label}
            </label>
            {f.type === "select" ? (
              <select
                id={`filter-${f.key}`}
                className="select"
                value={sp.get(f.key) ?? ""}
                onChange={(e) => apply(f.key, e.target.value)}
              >
                <option value="">All</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`filter-${f.key}`}
                className="input"
                defaultValue={sp.get(f.key) ?? ""}
                onBlur={(e) => apply(f.key, e.target.value)}
              />
            )}
          </div>
        ))}

        <div className="ml-auto flex items-end gap-2">
          {activeCount > 0 && (
            <button type="button" className="btn" onClick={clearAll}>
              Clear {activeCount} filter{activeCount === 1 ? "" : "s"}
            </button>
          )}
          {exportKind && (
            <>
              <a
                className="btn"
                href={`/api/export?kind=${exportKind}&format=xlsx&${sp.toString()}`}
              >
                Export to Excel
              </a>
              <a
                className="btn"
                href={`/api/export?kind=${exportKind}&format=csv&${sp.toString()}`}
              >
                Export to CSV
              </a>
            </>
          )}
        </div>
      </div>
      {pending && (
        <p className="mt-2 text-2xs text-ink-mute">Applying filters…</p>
      )}
    </div>
  );
}
