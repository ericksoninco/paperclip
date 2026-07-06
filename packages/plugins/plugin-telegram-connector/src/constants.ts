export const PLUGIN_ID = "paperclip.telegram-connector";
export const PLUGIN_VERSION = "0.1.0";
export const INBOUND_JOB_KEY = "telegram-inbound-long-poll";
export const STATE_NAMESPACE = "telegram-inbound";
export const OFFSET_STATE_KEY = "next-update-offset";
export const PROCESSED_UPDATE_PREFIX = "processed-update:";
export const ORIGIN_KIND = `plugin:${PLUGIN_ID}:telegram-message`;
