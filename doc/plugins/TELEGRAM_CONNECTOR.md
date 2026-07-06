# Telegram Bot Connector

The Telegram Bot Connector owns inbound `getUpdates` consumption for one Telegram bot and routes board messages into Paperclip issues. It deliberately does **not** set a Telegram webhook: Telegram webhooks and `getUpdates` are mutually exclusive, and the bot already has outbound send-message behavior that must not race a second update cursor.

## Cursor ownership

- The plugin registers one scheduled job, `telegram-inbound-long-poll`, running once per minute.
- Each run calls `getUpdates` with the persisted `next-update-offset` from company-scoped plugin state.
- Processed updates are also marked by update ID before the offset advances, so retrying the same update does not create duplicate Paperclip issues.
- Messages from non-allowlisted chats are acknowledged by advancing the cursor but are not routed.

## Routing

Configure:

- `tokenSecretRef`: secret reference for the Telegram bot token.
- `allowedChatId`: optional board chat allowlist, such as `7230170718`.
- `assigneeAgentId`: optional receiver for inbound Paperclip issues; when omitted the connector chooses the first active CEO agent.
- `projectId`: optional project for created issues.

Inbound messages create high-priority `todo` issues with `originKind` `plugin:paperclip.telegram-connector:telegram-message` and `originId` equal to the Telegram update ID. The issue body records sender, chat ID, Telegram message ID, update ID, timestamp, and message text/caption.

## Operational note

Only one component should consume `getUpdates` for a bot token. Once this connector is installed, configured, and verified, disable any interim routines that also call `getUpdates` for the same token.
