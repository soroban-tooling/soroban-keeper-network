/**
 * Client for the indexer's task endpoints (`indexer/openapi.yaml`). The indexer
 * is optional: `skn task list` uses it when `--indexer-url` or
 * `SKN_INDEXER_URL` is set, and reads the chain otherwise.
 */

export class IndexerError extends Error {}

/** One task as the indexer reports it. Only the fields the CLI reads are typed. */
export interface IndexerTaskState {
  task_id: number;
  owner: string;
  status: string;
  keeper: string | null;
  reward: string;
  deadline: number;
}

export interface IndexerTaskList {
  address: string;
  tasks: IndexerTaskState[];
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Lists the tasks an owner registered, or a keeper claimed or executed. */
export async function fetchIndexerTasks(
  baseUrl: string,
  path: { kind: "owner" | "keeper"; address: string },
  fetchImpl: FetchLike,
): Promise<IndexerTaskList> {
  const segment = path.kind === "owner" ? "owners" : "keepers";
  const url = `${baseUrl.replace(/\/+$/, "")}/${segment}/${encodeURIComponent(path.address)}/tasks`;

  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new IndexerError(`cannot reach the indexer at ${baseUrl}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new IndexerError(`the indexer returned HTTP ${response.status} for ${segment}/${path.address}`);
  }
  const body = (await response.json()) as Partial<IndexerTaskList> | null;
  if (body === null || !Array.isArray(body.tasks)) {
    throw new IndexerError("the indexer returned a response without a task list");
  }
  return { address: body.address ?? path.address, tasks: body.tasks };
}
