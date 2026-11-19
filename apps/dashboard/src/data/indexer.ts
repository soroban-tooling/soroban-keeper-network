import type { IndexedEvent, LeaderboardEntry, Page, TaskState } from "./types";

interface WirePage<T> {
  events?: T[];
  tasks?: T[];
  next_cursor?: number | null;
}

interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export class DashboardIndexer {
  constructor(private readonly baseUrl: string, private readonly fetchFn = fetch) {}

  async events(after?: number, limit = 200, eventType?: string): Promise<Page<IndexedEvent>> {
    const payload = await this.get<WirePage<IndexedEvent>>("/events", {
      after,
      limit,
      event_type: eventType,
    });
    return { items: payload.events ?? [], nextCursor: payload.next_cursor ?? null };
  }

  async task(taskId: number): Promise<TaskState> {
    const payload = await this.get<{ task: TaskState }>(`/tasks/${taskId}`);
    return payload.task;
  }

  async tasksByKeeper(keeper: string, after?: number, limit = 25): Promise<Page<TaskState>> {
    const payload = await this.get<WirePage<TaskState>>(
      `/keepers/${encodeURIComponent(keeper)}/tasks`,
      { after, limit },
    );
    return { items: payload.tasks ?? [], nextCursor: payload.next_cursor ?? null };
  }

  async leaderboard(
    rankBy: "executions" | "reward" | "reputation",
    limit = 100,
  ): Promise<LeaderboardEntry[]> {
    return (await this.get<LeaderboardResponse>("/leaderboard", { rank_by: rankBy, limit })).entries;
  }

  async allTasks(after?: number, limit = 25): Promise<Page<TaskState>> {
    const registrations = await this.events(after, limit, "task_registered");
    const ids = registrations.items
      .map((event) => Number(event.payload.task_id))
      .filter((id) => Number.isSafeInteger(id));
    const tasks = await Promise.all(ids.map((id) => this.task(id)));
    return { items: tasks, nextCursor: registrations.nextCursor };
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.set(key, String(value));
    });
    const response = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Indexer request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
}
