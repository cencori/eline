import type { ScheduleConfig } from "../types";

export function defineSchedule(config: ScheduleConfig): ScheduleConfig {
  if (!config.name || !config.cron || !config.handler) {
    throw new Error("Schedule must have name, cron, and handler");
  }
  return config;
}
