import { TaskExecutor } from "./interface.js";
import { MetricsCollector } from "../metrics.js";

export class ExecutorRegistry {
  private executors: Map<string, TaskExecutor> = new Map();

  constructor(private metrics?: MetricsCollector) {}

  /**
   * Registers a TaskExecutor. Automatically registers the task_type
   * with the metrics collector so metrics breakdown is provisioned with zero manual wiring.
   */
  public register(executor: TaskExecutor): void {
    const taskType = executor.taskType;
    this.executors.set(taskType, executor);

    if (this.metrics) {
      this.metrics.registerExecutor(taskType);
    }
  }

  public get(taskType: string): TaskExecutor | undefined {
    return this.executors.get(taskType);
  }

  public has(taskType: string): boolean {
    return this.executors.has(taskType);
  }

  public getAllTaskTypes(): string[] {
    return Array.from(this.executors.keys());
  }
}
