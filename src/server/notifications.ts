// Where X-Nix sends a notification, such as a job running well past its time: each channel in the config's
// `notifications` list, an ntfy topic, a webhook or Apprise's URLs, through the X-Libs senders.

// ── Imports ──────────────────────────────────────────────────────────────────

import { send_apprise, apprise_urls, type AppriseType } from "@x-tech-laboratories/x-libs/server/notify/apprise";
import { ntfy_priority, ntfy_settings, ntfy_tags, send_ntfy } from "@x-tech-laboratories/x-libs/server/notify/ntfy";
import { send_webhook, webhook_settings } from "@x-tech-laboratories/x-libs/server/notify/webhook";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Notification {
  title: string;
  body: string;
  level: "info" | "warning" | "error";
}

export type Channel = (notification: Notification) => Promise<void>;

export const channel_types = ["ntfy", "webhook", "apprise"] as const;

const apprise_types: Record<Notification["level"], AppriseType> = { info: "info", warning: "warning", error: "failure" };
const ntfy_priorities: Record<Notification["level"], number> = { info: 3, warning: 4, error: 5 };

// ── Reading ──────────────────────────────────────────────────────────────────

// Reads each channel's settings now, so a mistake, or a secret file that cannot be read, stops the server starting.
export function read_channels(entries: unknown): Channel[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new Error("`notifications` must be a list of channels");
  return entries.map((entry, index) => {
    const where = `notifications[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const config = entry as Record<string, unknown>;
    try {
      return channel(config);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
  });
}

function channel(config: Record<string, unknown>): Channel {
  if (config.type === "ntfy") {
    const settings = ntfy_settings(config);
    const priority = config.priority === undefined ? null : ntfy_priority(config.priority);
    const tags = config.tags === undefined ? [] : ntfy_tags(config.tags);
    return (notification) => send_ntfy(settings, { title: notification.title, message: notification.body, priority: priority ?? ntfy_priorities[notification.level], tags });
  }
  if (config.type === "webhook") {
    const settings = webhook_settings(config);
    return (notification) => send_webhook(settings, { values: { ...notification }, default_body: notification });
  }
  if (config.type === "apprise") {
    const urls = apprise_urls(config);
    return (notification) => send_apprise(urls, { title: notification.title, body: notification.body, type: apprise_types[notification.level] });
  }
  throw new Error(`\`type\` must be one of ${channel_types.join(", ")}`);
}

// ── Sending ──────────────────────────────────────────────────────────────────

export class Notifier {
  private readonly channels: Channel[];
  private readonly log: (message: string) => void;

  constructor(channels: Channel[], log: (message: string) => void = (message) => console.warn(message)) {
    this.channels = channels;
    this.log = log;
  }

  // Sends to every channel; one that fails is logged and the rest still get it.
  async send(notification: Notification): Promise<void> {
    await Promise.all(this.channels.map((send, index) => send(notification).catch((error: unknown) => {
      this.log(`Notification channel ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
    })));
  }
}
