// ${NAME} in a config file, read from the environment, so a key or URL never has to be written into it.

/**
 * Replaces each ${NAME} (NAME = [A-Za-z_][A-Za-z0-9_]*) in a JSON text with the environment value, escaped
 * for a JSON string. An unset or empty name is an error naming it, never an empty string. Other $ text is left alone.
 */
export function expandEnv(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => {
    const v = env[n];
    if (v === undefined || v === "") throw new Error(`env ${n} is not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}
