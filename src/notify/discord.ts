// Discord bot over the outbound gateway: DMs the owner, handles Register / Skip buttons and slash commands.

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type User,
} from "discord.js";
import { systemClock, type Clock } from "../core/clock";
import type { ControlApi } from "../core/contracts";
import type { Settings } from "../core/types";
import { SEVERITY_COLORS, type OutMessage } from "./format";

export type DiscordState = "off" | "connecting" | "ready" | "error";

export interface DiscordStatus {
  state: DiscordState;
  detail: string | null;
}

export type ButtonAction = "approve" | "skip";

// ---------- pure helpers (tested directly) ----------

export function approvalCustomId(action: ButtonAction, approvalId: number): string {
  return `${action}:${approvalId}`;
}

/** Parse "approve:<id>" or "skip:<id>". Anything else returns null. */
export function parseCustomId(customId: string): { action: ButtonAction; approvalId: number } | null {
  const match = /^(approve|skip):(\d{1,15})$/.exec(customId);
  if (!match) return null;
  const approvalId = Number(match[2]);
  if (!Number.isSafeInteger(approvalId) || approvalId <= 0) return null;
  return { action: match[1] as ButtonAction, approvalId };
}

/** Only the configured owner may press buttons or run commands. */
export function isAuthorized(userId: string | null | undefined, ownerId: string | null | undefined): boolean {
  return typeof userId === "string" && typeof ownerId === "string" && ownerId.length > 0 && userId === ownerId;
}

export const NOT_AUTHORIZED = "Not authorized";

export type ButtonOutcome =
  | { kind: "unauthorized" }
  | { kind: "invalid" }
  | { kind: "result"; action: ButtonAction; approvalId: number; ok: boolean; text: string };

/** Decide what a button press does, independent of discord.js objects. */
export async function resolveButtonPress(
  press: { customId: string; userId: string },
  ownerId: string | null,
  control: Pick<ControlApi, "approve" | "skip">,
): Promise<ButtonOutcome> {
  if (!isAuthorized(press.userId, ownerId)) return { kind: "unauthorized" };
  const parsed = parseCustomId(press.customId);
  if (!parsed) return { kind: "invalid" };
  try {
    const result =
      parsed.action === "approve"
        ? await control.approve(parsed.approvalId, "discord")
        : await control.skip(parsed.approvalId, "discord");
    return { kind: "result", ...parsed, ok: result.ok, text: result.detail };
  } catch (error) {
    return { kind: "result", ...parsed, ok: false, text: `Failed: ${(error as Error)?.message ?? String(error)}` };
  }
}

/** Readable text for errors from login and REST calls. */
export function describeDiscordError(error: unknown): string {
  const err = error as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = err?.code;
  if (code === "TokenInvalid" || code === 4004 || err?.status === 401) return "Discord rejected the bot token. Copy it again from the Developer Portal.";
  if (code === "TokenMissing") return "No bot token is set.";
  if (code === 4014 || code === "DisallowedIntents") return "Discord refused the requested intents.";
  if (code === 10013) return "Discord does not know that user ID. Check the ID in settings.";
  if (code === 50007 || code === 50278)
    return "Discord would not deliver the DM. The bot and your account must share a server, and that server must allow DMs.";
  if (code === 10008) return "The original Discord message no longer exists.";
  if (err?.status === 429) return "Discord is rate limiting the bot. It will try again shortly.";
  const message = typeof err?.message === "string" ? err.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}

function isInvalidToken(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown } | null;
  return err?.code === "TokenInvalid" || err?.code === 4004 || err?.status === 401;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, attempt));
}

export const MAX_RETRY_MS = 10 * 60_000;

// ---------- message rendering ----------

export function renderEmbed(message: OutMessage): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(SEVERITY_COLORS[message.severity]).setTitle(message.title.slice(0, 256));
  if (message.body) embed.setDescription(message.body.slice(0, 4000));
  return embed;
}

export function approvalButtons(approvalId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(approvalCustomId("approve", approvalId)).setLabel("Register").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(approvalCustomId("skip", approvalId)).setLabel("Skip").setStyle(ButtonStyle.Secondary),
  );
}

export function slashCommands() {
  const base = (name: string, description: string) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);
  return [
    base("status", "Show watcher status"),
    base("pause", "Pause all seat checks and registration"),
    base("resume", "Resume seat checks and registration"),
  ];
}

// ---------- the bot ----------

export interface DiscordChannelDeps {
  settings: () => Settings;
  control: () => ControlApi | null;
  clock?: Clock;
  /** Overridable for tests. */
  createClient?: () => Client;
  log?: (message: string, error?: unknown) => void;
}

export interface DiscordSendOptions {
  approvalId?: number;
  replyTo?: string | null;
}

export class DiscordChannel {
  private client: Client | null = null;
  private generation = 0;
  private attempt = 0;
  private retryTimer: { cancel(): void } | null = null;
  private current: DiscordStatus = { state: "off", detail: null };
  private clock: Clock;
  private log: (message: string, error?: unknown) => void;

  constructor(private deps: DiscordChannelDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? ((message, error) => console.warn(`[discord] ${message}`, error ?? ""));
  }

  status(): DiscordStatus {
    return { ...this.current };
  }

  /** (Re)connect using the current token. Never throws. */
  async start(): Promise<void> {
    await this.stop();
    const generation = this.generation;
    const { discordToken, discordUserId } = this.deps.settings();
    if (!discordToken) {
      this.current = { state: "off", detail: "Add a bot token to connect." };
      return;
    }
    this.current = { state: "connecting", detail: discordUserId ? null : "Add your Discord user ID so the bot knows who to DM." };
    const client = this.deps.createClient
      ? this.deps.createClient()
      : new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
    this.client = client;
    this.attach(client, generation);
    try {
      await client.login(discordToken);
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error, generation);
    }
  }

  private attach(client: Client, generation: number) {
    const live = () => generation === this.generation;
    client.once(Events.ClientReady, async ready => {
      if (!live()) return;
      this.attempt = 0;
      const userId = this.deps.settings().discordUserId;
      this.current = {
        state: "ready",
        detail: userId ? `Connected as ${ready.user.tag}` : `Connected as ${ready.user.tag}. Add your Discord user ID so the bot knows who to DM.`,
      };
      try {
        await ready.application.commands.set(slashCommands().map(command => command.toJSON()));
      } catch (error) {
        this.log("could not register slash commands", error);
      }
    });
    client.on(Events.InteractionCreate, interaction => {
      if (!live()) return;
      void this.onInteraction(interaction).catch(error => this.log("interaction failed", error));
    });
    client.on(Events.ShardDisconnect, event => {
      if (!live()) return;
      if (event.code === 4004) this.fail({ code: 4004 }, generation);
    });
    client.on(Events.ShardReconnecting, () => {
      if (live() && this.current.state === "ready") this.current = { state: "connecting", detail: "Reconnecting" };
    });
    client.on(Events.ShardResume, () => {
      if (live() && this.client?.user) this.current = { state: "ready", detail: `Connected as ${this.client.user.tag}` };
    });
    client.on(Events.ShardReady, () => {
      if (live() && this.client?.user && this.current.state === "connecting")
        this.current = { state: "ready", detail: `Connected as ${this.client.user.tag}` };
    });
    client.on(Events.Invalidated, () => {
      if (live()) this.fail(new Error("Discord invalidated the session."), generation);
    });
    client.on(Events.Error, error => {
      if (live()) this.log("client error", error);
    });
  }

  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    const detail = describeDiscordError(error);
    const delay = isInvalidToken(error) ? MAX_RETRY_MS : retryDelayMs(this.attempt);
    this.attempt++;
    this.current = { state: "error", detail: `${detail} Retrying in ${Math.round(delay / 60_000) || 1} min.` };
    const client = this.client;
    this.client = null;
    void client?.destroy().catch(() => {});
    this.retryTimer?.cancel();
    this.retryTimer = this.clock.setTimeout(() => {
      if (generation !== this.generation) return;
      this.retryTimer = null;
      void this.start();
    }, delay);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.retryTimer?.cancel();
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.destroy();
      } catch (error) {
        this.log("destroy failed", error);
      }
    }
    this.current = { state: "off", detail: null };
  }

  /** Re-read token and user and reconnect. */
  async reload(): Promise<void> {
    this.attempt = 0;
    await this.start();
  }

  private async owner(): Promise<User> {
    const client = this.client;
    if (!client || this.current.state !== "ready" || !client.isReady()) {
      throw new Error(this.current.detail ? `Discord is not connected: ${this.current.detail}` : "Discord is not connected.");
    }
    const userId = this.deps.settings().discordUserId;
    if (!userId) throw new Error("Add your Discord user ID in settings.");
    return client.users.fetch(userId);
  }

  /** DM the owner. Returns the message id. Throws with a readable message on failure. */
  async send(message: OutMessage, options: DiscordSendOptions = {}): Promise<string> {
    try {
      const user = await this.owner();
      const sent = await user.send({
        embeds: [renderEmbed(message)],
        components: options.approvalId !== undefined ? [approvalButtons(options.approvalId)] : [],
        reply: options.replyTo ? { messageReference: options.replyTo, failIfNotExists: false } : undefined,
      });
      return sent.id;
    } catch (error) {
      throw new Error(describeDiscordError(error));
    }
  }

  /** Replace an earlier DM (used to show an approval result and remove its buttons). */
  async edit(messageId: string, message: OutMessage): Promise<void> {
    try {
      const user = await this.owner();
      const dm = user.dmChannel ?? (await user.createDM());
      await dm.messages.edit(messageId, { embeds: [renderEmbed(message)], components: [] });
    } catch (error) {
      throw new Error(describeDiscordError(error));
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    const ownerId = this.deps.settings().discordUserId;
    if (interaction.isButton()) return this.onButton(interaction, ownerId);
    if (interaction.isChatInputCommand()) return this.onCommand(interaction, ownerId);
  }

  private async onButton(interaction: ButtonInteraction, ownerId: string | null) {
    if (!isAuthorized(interaction.user.id, ownerId)) {
      await interaction.reply({ content: NOT_AUTHORIZED, flags: MessageFlags.Ephemeral });
      return;
    }
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      await interaction.reply({ content: "That button is no longer valid.", flags: MessageFlags.Ephemeral });
      return;
    }
    const control = this.deps.control();
    if (!control) {
      await interaction.reply({ content: "The app is still starting. Try again in a moment.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Acknowledge within Discord's 3 second window and remove the buttons so they cannot be pressed twice.
    const original = interaction.message.embeds[0];
    const pending = new EmbedBuilder()
      .setColor(SEVERITY_COLORS.info)
      .setTitle(original?.title ?? "Approval")
      .setDescription(parsed.action === "approve" ? "Registering..." : "Skipping...");
    await interaction.update({ embeds: [pending], components: [] });
    const outcome = await resolveButtonPress({ customId: interaction.customId, userId: interaction.user.id }, ownerId, control);
    if (outcome.kind !== "result") return;
    const done = new EmbedBuilder()
      .setColor(outcome.ok ? (outcome.action === "approve" ? SEVERITY_COLORS.success : SEVERITY_COLORS.info) : SEVERITY_COLORS.warning)
      .setTitle(original?.title ?? "Approval")
      .setDescription(outcome.text.slice(0, 4000) || (outcome.ok ? "Done" : "Failed"));
    await interaction.editReply({ embeds: [done], components: [] });
  }

  private async onCommand(interaction: ChatInputCommandInteraction, ownerId: string | null) {
    if (!isAuthorized(interaction.user.id, ownerId)) {
      await interaction.reply({ content: NOT_AUTHORIZED, flags: MessageFlags.Ephemeral });
      return;
    }
    const control = this.deps.control();
    if (!control) {
      await interaction.reply({ content: "The app is still starting. Try again in a moment.", flags: MessageFlags.Ephemeral });
      return;
    }
    const flags = interaction.inGuild() ? MessageFlags.Ephemeral : undefined;
    switch (interaction.commandName) {
      case "status":
        await interaction.reply({ content: control.statusText().slice(0, 2000) || "No status available.", flags });
        return;
      case "pause":
        control.pauseAll("discord");
        await interaction.reply({ content: "Paused. Nothing will be checked or registered until you /resume.", flags });
        return;
      case "resume":
        control.resumeAll("discord");
        await interaction.reply({ content: "Resumed.", flags });
        return;
      default:
        await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
    }
  }
}
