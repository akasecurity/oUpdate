/**
 * Whether a JSON text, already known to parse, has an object with the same key twice. JSON.parse keeps the last one, and
 * another reader of the same bytes may keep the first, so a reviewer answer with a repeated key is not one answer. Keys are
 * compared as decoded ("choices" is "choices"). One pass, so linear in the text.
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let wantKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      stack.push(new Set());
      wantKey = true;
    } else if (c === "[") {
      stack.push(null);
      wantKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      wantKey = false;
    } else if (c === ",") {
      wantKey = stack.at(-1) instanceof Set;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (wantKey && top instanceof Set) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
        wantKey = false;
      }
      i = j;
    }
  }
  return false;
}
