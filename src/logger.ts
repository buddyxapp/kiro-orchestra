/** Minimal structured logger */
export const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : '');
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : '');
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : '');
  },
  debug(msg: string, data?: Record<string, unknown>) {
    if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : '');
  },
};
