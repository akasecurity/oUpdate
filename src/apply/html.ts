/** Registry and model text for a notice that is HTML: markup characters are entities, so a hook body or a reason cannot add tags. */
export const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
