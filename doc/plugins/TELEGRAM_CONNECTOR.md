# Telegram Bot Connector

The Telegram Bot Connector owns inbound `getUpdates` consumption for one Telegram bot and routes board messages into Paperclip issues. It deliberately does **not** set a Telegram webhook: Telegram webhooks and `getUpdates` are mutually exclusive. On startup the connector calls `deleteWebhook` defensively so a previously configured webhook cannot collide with long-polling.

## Cursor ownership

- The plugin registers one scheduled job, `telegram-inbound-long-poll`, running once per minute.
- Each run calls `getUpdates` with the persisted `next-update-offset` from company-scoped plugin state. The connector is a **single-company cursor owner**: set `companyId` in config when the instance has more than one company; otherwise startup fails closed because Telegram offsets are global per bot token.
- The default `timeoutSeconds` is 20 seconds and the maximum is 25 seconds. The worker-to-host `http.fetch` bridge times out requests at 30 seconds, so the connector keeps Telegram long-polls below that hard ceiling while still leaving margin inside the one-minute schedule interval. Do not run another `getUpdates` consumer for the same bot.
- Processed updates are marked by update ID before the offset advances, and issue creation is checked by `originKind` + `originId`, so retrying the same update does not create duplicate Paperclip issues.
- Messages from non-allowlisted chats are acknowledged by advancing the cursor but are not routed.

## Routing

Configure:

- `tokenSecretRef`: secret reference for the Telegram bot token.
- `companyId`: required when the Paperclip instance has more than one company; identifies the company whose plugin state owns the bot's global Telegram cursor.
- `allowedChatId`: optional board chat allowlist, such as `7230170718`.
- `assigneeAgentId`: optional receiver for inbound Paperclip issues; when omitted the connector chooses the CEO agent by role/name regardless of whether that agent is currently idle or busy.
- `projectId`: optional project for created issues.
- `timeoutSeconds`: optional long-poll timeout, defaults to 20 seconds and is capped at 25 seconds to stay below the host `http.fetch` timeout.

Inbound messages create high-priority `todo` issues with `originKind` `plugin:paperclip.telegram-connector:telegram-message` and `originId` equal to the Telegram update ID. The issue body records sender, chat ID, Telegram message ID, update ID, timestamp, and message text/caption.

## Operational note

Only one component should consume `getUpdates` for a bot token. Once this connector is installed, configured, and verified, disable any interim routines that also call `getUpdates` for the same token. Outbound send-message bot usage can continue; it does not own the inbound update cursor.
