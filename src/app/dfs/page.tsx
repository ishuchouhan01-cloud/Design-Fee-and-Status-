import { redirect } from 'next/navigation';

/** `/dfs` is a short link to the DFS, which lives at `/drawings` (the URL existing links use). */
export default async function DfsRedirect({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = new URLSearchParams(await searchParams).toString();
  redirect(`/drawings${sp ? `?${sp}` : ''}`);
}
