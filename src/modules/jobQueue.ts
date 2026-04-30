import { config } from "../config.js";
import { log } from "../logger.js";
import type { ValidationJob } from "../types.js";

type JobHandler = (job: ValidationJob) => Promise<void>;

export class JobQueue {
  private readonly queue: ValidationJob[] = [];
  private running = 0;

  constructor(private readonly handler: JobHandler) {}

  enqueue(job: ValidationJob): ValidationJob {
    this.queue.push(job);
    this.drain();
    return job;
  }

  stats(): { queued: number; running: number; concurrency: number } {
    return {
      queued: this.queue.length,
      running: this.running,
      concurrency: config.jobConcurrency
    };
  }

  private drain(): void {
    while (this.running < config.jobConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }

      this.running += 1;
      this.handler(job)
        .catch((error) => {
          log("error", "Falha ao processar job", {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }
}
