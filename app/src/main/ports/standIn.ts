/** Both stand-ins carry `standIn: true`. The engine refuses them in a production build. */
export const isStandIn = (value: unknown): boolean => (value as {standIn?: unknown} | null)?.standIn === true;
